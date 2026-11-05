// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type ActivityState,
  activityFinishRequestedEvent,
  activityInterruptedEvent,
  activityPauseRequestedEvent,
  activityResumeRequestedEvent,
  activityStartRequestedEvent,
  activityStateChangedEvent,
  definePlugin,
  type PluginContext,
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
 * Ride lifecycle `idle -> running <-> paused -> finished`, driven by request events (ADR 0056).
 * Knows nothing about any UI.
 */
export default definePlugin({
  start(ctx) {
    transition(ctx, { state: 'idle' });
    const current = (): ActivityState => states.get(ctx) ?? { state: 'idle' };

    ctx.events.subscribe(activityStartRequestedEvent, () => {
      const state = current();
      if (state.state === 'running' || state.state === 'paused') {
        reject(ctx, 'start', state);
        return;
      }
      transition(ctx, {
        state: 'running',
        sessionId: ctx.ids.next(),
        startedAt: ctx.clock.now(),
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
      });
    });
  },
});
