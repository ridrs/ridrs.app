// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  activityStateChangedEvent,
  definePlugin,
  equipmentBicycleChangedEvent,
  type PluginContext,
} from '@ridrs/contracts';
import { BICYCLE_DOCUMENT, DEFAULT_BICYCLE, resolveBicycle } from './bicycle.ts';

/** The kept bicycle, resolved for a ride; the default one without a document. */
async function keptBicycle(ctx: PluginContext) {
  return resolveBicycle((await ctx.settings.user(BICYCLE_DOCUMENT).read()) ?? DEFAULT_BICYCLE);
}

/**
 * The garage's host side (ADR 0060): hands the kept bicycle to the next ride as the input
 * `equipment.bicycle-changed`, at host start and again when a ride finishes (so a ride continued
 * from its journal, which re-enters the recorded bicycle, is followed by the garage's one). The
 * client hands over every change itself. The activity session freezes the bicycle at a ride's
 * start; nothing here changes a ride under way.
 */
export default definePlugin({
  async start(ctx) {
    let handedOver = false;
    ctx.events.subscribe(equipmentBicycleChangedEvent, () => {
      handedOver = true;
    });
    ctx.events.subscribe(activityStateChangedEvent, ({ payload }) => {
      if (payload.state === 'finished') {
        void keptBicycle(ctx).then((bicycle) => ctx.inputs.accept(equipmentBicycleChangedEvent, bicycle));
      }
    });
    const bicycle = await keptBicycle(ctx);
    // A change from the garage screen while the document was read is newer.
    if (!handedOver) {
      ctx.inputs.accept(equipmentBicycleChangedEvent, bicycle);
    }
  },
});
