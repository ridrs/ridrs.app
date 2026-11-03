// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type ActivityState,
  activityFinishRequestedEvent,
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

/** Ride lifecycle `idle -> running -> finished`, driven by request events. Knows nothing about any UI. */
export default definePlugin({
  start(ctx) {
    transition(ctx, { state: 'idle' });

    ctx.events.subscribe(activityStartRequestedEvent, () => {
      const current = states.get(ctx) ?? { state: 'idle' };
      if (current.state === 'running') {
        reject(ctx, 'start', current);
        return;
      }
      transition(ctx, {
        state: 'running',
        sessionId: ctx.ids.next(),
        startedAt: ctx.clock.now(),
      });
    });

    ctx.events.subscribe(activityFinishRequestedEvent, () => {
      const current = states.get(ctx) ?? { state: 'idle' };
      if (current.state !== 'running') {
        reject(ctx, 'finish', current);
        return;
      }
      transition(ctx, {
        state: 'finished',
        sessionId: current.sessionId,
        startedAt: current.startedAt,
        endedAt: ctx.clock.now(),
      });
    });
  },
});
