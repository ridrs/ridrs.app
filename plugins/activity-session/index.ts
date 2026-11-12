// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  activityAthleteEvent,
  activityEquipmentEvent,
  type ActivityState,
  activityFinishRequestedEvent,
  activityInterruptedEvent,
  activityPauseRequestedEvent,
  activityResumeRequestedEvent,
  activityStartRequestedEvent,
  activityStateChangedEvent,
  athleteProfileChangedEvent,
  type Bicycle,
  definePlugin,
  equipmentBicycleChangedEvent,
  type PluginContext,
  type RideAthlete,
} from '@ridrs/contracts';

const states = new WeakMap<PluginContext, ActivityState>();

function transition(ctx: PluginContext, next: ActivityState): void {
  states.set(ctx, next);
  ctx.logger.info({ state: next.state }, `activity ${next.state}`);
  ctx.events.publish(activityStateChangedEvent, next);
}

function reject(ctx: PluginContext, request: string, current: ActivityState): void {
  ctx.reportDiagnostic(
    'invalid-transition',
    `Cannot ${request} a ride while the activity is "${current.state}"`,
    { request, state: current.state },
  );
}

/**
 * What a ride's start fixed, kept from its start to its end: its world (none for a free ride) and
 * its workout (none without one). Both are ride input (AGENTS.md rule 13): a replay and a
 * continued ride read them from the recorded states.
 */
const fixedOf = (state: ActivityState) => ({
  ...('world' in state && state.world ? { world: state.world } : {}),
  ...('workout' in state && state.workout ? { workout: state.workout } : {}),
});

/**
 * Ride lifecycle `idle -> running <-> paused -> finished`, driven by request events (ADR 0056).
 * Knows nothing about any UI. Freezes the latest bicycle (`equipment.bicycle-changed`) for every
 * new session and announces it as `activity.equipment` right before the session runs; pause,
 * resume and a continued ride keep it (ADR 0060). The athlete is frozen the same way, from
 * `athlete.profile-changed` into `activity.athlete` (ADR 0075). Without a bicycle or an athlete
 * it announces none. The world a start asks for (a landscape and its route) and its workout,
 * resolved at the start (structured-workouts.md, section 11), stay with the ride in every state
 * until it ends.
 */
export default definePlugin({
  start(ctx) {
    transition(ctx, { state: 'idle' });
    const current = (): ActivityState => states.get(ctx) ?? { state: 'idle' };
    let bicycle: Bicycle | undefined;
    ctx.events.subscribe(equipmentBicycleChangedEvent, ({ payload }) => {
      bicycle = payload;
    });
    let athlete: RideAthlete | undefined;
    ctx.events.subscribe(athleteProfileChangedEvent, ({ payload }) => {
      athlete = payload;
    });

    ctx.events.subscribe(activityStartRequestedEvent, ({ payload }) => {
      const state = current();
      if (state.state === 'running' || state.state === 'paused') {
        reject(ctx, 'start', state);
        return;
      }
      const sessionId = ctx.ids.next();
      if (bicycle) {
        ctx.events.publish(activityEquipmentEvent, { sessionId, bicycle });
      }
      if (athlete) {
        ctx.events.publish(activityAthleteEvent, { sessionId, athlete });
      }
      transition(ctx, {
        state: 'running',
        sessionId,
        startedAt: ctx.clock.now(),
        ...(payload.world ? { world: payload.world } : {}),
        ...(payload.workout ? { workout: payload.workout } : {}),
      });
    });

    const pause = (request: string, reason: 'rider' | 'interrupted') => {
      const state = current();
      if (state.state !== 'running') {
        reject(ctx, request, state);
        return;
      }
      transition(ctx, {
        state: 'paused',
        sessionId: state.sessionId,
        startedAt: state.startedAt,
        pausedAt: ctx.clock.now(),
        reason,
        ...fixedOf(state),
      });
    };
    ctx.events.subscribe(activityPauseRequestedEvent, () => pause('pause', 'rider'));
    ctx.events.subscribe(activityInterruptedEvent, () => pause('interrupt', 'interrupted'));

    ctx.events.subscribe(activityResumeRequestedEvent, () => {
      const state = current();
      if (state.state !== 'paused') {
        reject(ctx, 'resume', state);
        return;
      }
      transition(ctx, {
        state: 'running',
        sessionId: state.sessionId,
        startedAt: state.startedAt,
        resumedAt: ctx.clock.now(),
        ...fixedOf(state),
      });
    });

    ctx.events.subscribe(activityFinishRequestedEvent, () => {
      const state = current();
      if (state.state !== 'running' && state.state !== 'paused') {
        reject(ctx, 'finish', state);
        return;
      }
      transition(ctx, {
        state: 'finished',
        sessionId: state.sessionId,
        startedAt: state.startedAt,
        endedAt: ctx.clock.now(),
        ...fixedOf(state),
      });
    });
  },
});
