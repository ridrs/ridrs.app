// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  activityStateChangedEvent,
  definePlugin,
  type PluginContext,
  PhysicsStepError,
  physicsMotionCapability,
  physicsStateBatchEvent,
  physicsStateEvent,
} from '@ridrs/contracts';
import { type Subscription, timer } from 'rxjs';
import { ENGINE_DEFAULTS, RideSimulation } from './simulation.ts';

interface Engine {
  ride?: RideSimulation;
  /** The one step timer, armed only while a ride runs. */
  wake?: Subscription;
}

const engines = new WeakMap<PluginContext, Engine>();

function engineOf(ctx: PluginContext): Engine {
  const engine = engines.get(ctx);
  if (!engine) {
    throw new Error('physics engine is not started');
  }
  return engine;
}

function stopRide(engine: Engine): void {
  engine.wake?.unsubscribe();
  engine.wake = undefined;
  engine.ride = undefined;
}

/** A failing contributor stops this ride's simulation - not the host, the metrics or the UI. */
function fail(ctx: PluginContext, sessionId: string, step: number, error: unknown): void {
  stopRide(engineOf(ctx));
  const plugin = error instanceof PhysicsStepError ? error.pluginId : undefined;
  const reason = error instanceof Error ? error.message : String(error);
  ctx.reportDiagnostic(
    'physics-step-failed',
    `Physics step ${step} failed${plugin ? ` in "${plugin}"` : ''}: ${reason}`,
    { ...(plugin ? { plugin } : {}), step, sessionId },
  );
}

/** Runs `compute` for the ride; any exception fails the ride at its pending step. */
function guarded(ctx: PluginContext, ride: RideSimulation, compute: () => void): boolean {
  try {
    compute();
    return true;
  } catch (error) {
    fail(ctx, ride.sessionId, ride.nextStep(), error);
    return false;
  }
}

/** Re-arms the one timer to the next due step; a late wake catches up in order, in chunks. */
function arm(ctx: PluginContext, ride: RideSimulation, delay?: number): void {
  const engine = engineOf(ctx);
  engine.wake?.unsubscribe();
  engine.wake = timer(delay ?? Math.max(0, ride.nextDueAt() - ctx.clock.now())).subscribe(() => {
    engine.wake = undefined;
    let more = false;
    const ok = guarded(ctx, ride, () => {
      more = ride.advanceUntil(ctx.clock.now(), ENGINE_DEFAULTS.maxStepsPerWake);
    });
    if (ok && engine.ride === ride) {
      arm(ctx, ride, more ? 0 : undefined);
    }
  });
}

/**
 * The simulation clock: a fixed 10 ms step while a ride runs, publishing `physics.state` and
 * every step's sample in `physics.state-batch`. It knows nothing about frames or rendering. The
 * only physics plugin with a timer and with events; it knows nothing but `physics.motion`.
 */
export default definePlugin({
  start(ctx) {
    const engine: Engine = {};
    engines.set(ctx, engine);
    const motion = ctx.capabilities.get(physicsMotionCapability);

    ctx.events.subscribe(activityStateChangedEvent, ({ payload }) => {
      if (payload.state === 'running') {
        stopRide(engine);
        try {
          engine.ride = new RideSimulation(payload.sessionId, payload.startedAt, motion, {
            state: (state) => ctx.events.publish(physicsStateEvent, state),
            batch: (batch) => ctx.events.publish(physicsStateBatchEvent, batch),
          });
        } catch (error) {
          fail(ctx, payload.sessionId, 0, error);
          return;
        }
        arm(ctx, engine.ride);
        return;
      }
      const ride = engine.ride;
      if (payload.state === 'finished' && ride?.sessionId === payload.sessionId) {
        guarded(ctx, ride, () => ride.finish(payload.endedAt));
        stopRide(engine);
      }
    });
  },

  stop(ctx) {
    const engine = engines.get(ctx);
    if (engine) {
      stopRide(engine);
    }
    engines.delete(ctx);
  },
});
