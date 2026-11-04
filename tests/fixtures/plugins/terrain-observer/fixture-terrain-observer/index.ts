// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  activityStateChangedEvent,
  definePlugin,
  type EventDefinition,
  physicsStateBatchEvent,
  uiTerrainObservedEvent,
  worldTerrainPreviewEvent,
} from '@ridrs/contracts';

/**
 * Records, in the e2e app, what the landscape observed, what the driver accepted and the
 * odometer, so steps can check when windows went out. Subscribes in initialize: the landscape's
 * first window goes out as soon as it is mounted.
 */
/** The scenario's World, as tests/support/world.ts registers it. */
function activeWorld(): { readonly hostObserved: unknown[] } {
  const world = (globalThis as Record<symbol, unknown>)[Symbol.for('ridrs.test.activeWorld')];
  if (!world) {
    throw new Error('No active RidrsWorld registered');
  }
  return world as { readonly hostObserved: unknown[] };
}

export default definePlugin({
  initialize(ctx) {
    const world = activeWorld();
    const events: EventDefinition[] = [
      activityStateChangedEvent,
      physicsStateBatchEvent,
      uiTerrainObservedEvent,
      worldTerrainPreviewEvent,
    ];
    for (const event of events) {
      ctx.events.subscribe(event, (envelope) => {
        world.hostObserved.push(envelope);
      });
    }
  },
});
