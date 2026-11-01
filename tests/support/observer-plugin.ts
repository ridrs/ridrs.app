// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  definePlugin,
  deviceConnectionChangedEvent,
  type EventDefinition,
  measurementCadenceEvent,
  measurementPowerEvent,
  metricCadenceEvent,
  metricPowerEvent,
} from '@ridrs/contracts';
import { getActiveWorld } from './world.ts';

/** Records every Phase 2 event in the World so steps can assert on them. */
export default definePlugin({
  // Subscribes in initialize so that events published while other plugins start are not missed.
  initialize(ctx) {
    const world = getActiveWorld();
    const events: EventDefinition[] = [
      deviceConnectionChangedEvent,
      measurementPowerEvent,
      measurementCadenceEvent,
      metricPowerEvent,
      metricCadenceEvent,
    ];
    for (const event of events) {
      ctx.events.subscribe(event, (envelope) => {
        world.observed.push(envelope);
      });
    }
  },
});
