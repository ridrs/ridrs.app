// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  definePlugin,
  deviceConnectionChangedEvent,
  type EventDefinition,
  measurementCadenceEvent,
  measurementHeartRateEvent,
  measurementPowerEvent,
  metricCadenceEvent,
  metricHeartRateEvent,
  metricPowerEvent,
  metricPowerHeartRateRatioEvent,
} from '@ridrs/contracts';
import { getActiveWorld } from './world.ts';

/** Records every device, measurement and metric event in the World so steps can assert on them. */
export default definePlugin({
  // Subscribes in initialize so that events published while other plugins start are not missed.
  initialize(ctx) {
    const world = getActiveWorld();
    const events: EventDefinition[] = [
      deviceConnectionChangedEvent,
      measurementPowerEvent,
      measurementCadenceEvent,
      measurementHeartRateEvent,
      metricPowerEvent,
      metricCadenceEvent,
      metricHeartRateEvent,
      metricPowerHeartRateRatioEvent,
    ];
    for (const event of events) {
      ctx.events.subscribe(event, (envelope) => {
        world.observed.push(envelope);
      });
    }
  },
});
