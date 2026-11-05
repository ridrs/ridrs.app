// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  activityStateChangedEvent,
  configSnapshotCapability,
  definePlugin,
  type PluginContext,
  PhysicsStepError,
  physicsMotionCapability,
  physicsStateBatchEvent,
  physicsStateEvent,
  physicsTrainerLoadCapability,
  type TaskId,
} from '@ridrs/contracts';
import { ENGINE_DEFAULTS, RideSimulation } from './simulation.ts';

interface Engine {
  ride?: RideSimulation;
  /** The one scheduled task (step 0 or the next step), only while a ride starts or runs. */
  wake?: TaskId;
  /** The ride stands still: no task is scheduled (ADR 0056). */
  paused?: boolean;
}

const engines = new WeakMap<PluginContext, Engine>();

function engineOf(ctx: PluginContext): Engine {
  const engine = engines.get(ctx);
  if (!engine) {
    throw new Error('physics engine is not started');
  }
  return engine;
}

function stopRide(ctx: PluginContext, engine: Engine): void {
  if (engine.wake !== undefined) {
    ctx.clock.cancel(engine.wake);
  }
  engine.wake = undefined;
  engine.ride = undefined;
  engine.paused = false;
}

/** A failing contributor stops this ride's simulation - not the host, the metrics or the UI. */
function fail(ctx: PluginContext, sessionId: string, step: number, error: unknown): void {
  stopRide(ctx, engineOf(ctx));
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

/**
 * Schedules the next step at its planned time `startedAt + 10·n` on the host clock. The task
 * observes that time however late it runs, so it computes exactly that step; a late host runs the
 * overdue steps one by one, each at its own time (the clock catches up in order, in chunks).
 */
function arm(ctx: PluginContext, ride: RideSimulation): void {
  const engine = engineOf(ctx);
  engine.wake = ctx.clock.scheduleAt(ride.nextDueAt(), () => {
    engine.wake = undefined;
    const ok = guarded(ctx, ride, () => {
      ride.advanceUntil(ctx.clock.now(), ENGINE_DEFAULTS.maxStepsPerWake);
    });
    if (ok && engine.ride === ride) {
      arm(ctx, ride);
    }
  });
}

/**
 * The simulation clock: a fixed 10 ms step while a ride runs, publishing `physics.state` and
 * every step's sample in `physics.state-batch`. It knows nothing about frames or rendering. The
 * only physics plugin with a timer; it knows nothing but `physics.motion` and, when installed,
 * `physics.trainer-load`, which it asks once per step after the motion.
 */
export default definePlugin({
  initialize(ctx) {
    ctx.capabilities.provide(configSnapshotCapability, {
      section: ctx.manifest.id,
      snapshot: () => ({ ...ENGINE_DEFAULTS }),
    });
  },

  start(ctx) {
    const engine: Engine = {};
    engines.set(ctx, engine);
    const motion = ctx.capabilities.get(physicsMotionCapability);

    /**
     * Step 0 runs as a task at the ride's start time, after the turn that started the ride: what
     * other plugins publish in reaction to `running` (a world's first terrain window) is there
     * before it, whatever the plugin order. Same logical time, so the states do not move.
     */
    const begin = (sessionId: string, startedAt: number) => {
      engine.wake = undefined;
      try {
        engine.ride = new RideSimulation(
          sessionId,
          startedAt,
          motion,
          {
            state: (state) => ctx.events.publish(physicsStateEvent, state),
            batch: (batch) => ctx.events.publish(physicsStateBatchEvent, batch),
          },
          ctx.capabilities.find(physicsTrainerLoadCapability),
        );
      } catch (error) {
        fail(ctx, sessionId, 0, error);
        return;
      }
      arm(ctx, engine.ride);
    };

    ctx.events.subscribe(activityStateChangedEvent, ({ payload }) => {
      const current = engine.ride;
      if (payload.state === 'paused' && current?.sessionId === payload.sessionId) {
        if (engine.wake !== undefined) {
          ctx.clock.cancel(engine.wake);
          engine.wake = undefined;
        }
        engine.paused = true;
        return;
      }
      if (
        payload.state === 'running' &&
        payload.resumedAt !== undefined &&
        current?.sessionId === payload.sessionId &&
        engine.paused
      ) {
        engine.paused = false;
        current.resume(payload.resumedAt);
        arm(ctx, current);
        return;
      }
      if (payload.state === 'running') {
        stopRide(ctx, engine);
        const { sessionId, startedAt } = payload;
        // A finish request is an input of its own, and inputs of the same time run after tasks:
        // step 0 always runs before the ride can finish.
        engine.wake = ctx.clock.scheduleAt(startedAt, () => begin(sessionId, startedAt));
        return;
      }
      const ride = engine.ride;
      if (payload.state === 'finished' && ride?.sessionId === payload.sessionId) {
        const paused = engine.paused === true;
        guarded(ctx, ride, () => ride.finish(payload.endedAt, paused));
        stopRide(ctx, engine);
      }
    });
  },

  stop(ctx) {
    const engine = engines.get(ctx);
    if (engine) {
      stopRide(ctx, engine);
    }
    engines.delete(ctx);
  },
});
