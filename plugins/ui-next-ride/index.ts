// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  activityStateChangedEvent,
  definePlugin,
  NEXT_RIDE_KEY,
  type NextRide,
  nextRideSchema,
  nextRideSetService,
  nextRideState,
  rodeNextRide,
  type SettingsDocument,
} from '@ridrs/contracts';

/** The next ride, kept beside the app (ADR 0059): it is still there after a restart. */
const KEPT: SettingsDocument<NextRide> = { name: 'next-ride', version: 1, schema: nextRideSchema };

/**
 * The host side of the next ride (ADR 0096) owns the app state `ride.next`: the menu section
 * writes it through `ride.next-set`, and a ride that finishes with everything it holds clears it.
 * An interrupted ride is paused, not finished, so the next ride stays until it is.
 */
export default definePlugin({
  async start(ctx) {
    const kept = ctx.settings.user(KEPT);
    // The key exists from the start: a keyed service reaches only the keys that have an owner.
    ctx.state.set(nextRideState, NEXT_RIDE_KEY, {});
    let written = false;
    const replace = async (ride: NextRide) => {
      written = true;
      ctx.state.set(nextRideState, NEXT_RIDE_KEY, ride);
      await kept.write(ride);
    };
    ctx.services.provide(nextRideSetService, async ({ key, ride }) => {
      if (key !== NEXT_RIDE_KEY) throw new Error(`There is one next ride, "${NEXT_RIDE_KEY}", not "${key}"`);
      await replace(ride);
      return {};
    });
    ctx.events.subscribe(activityStateChangedEvent, ({ payload }) => {
      const next = ctx.state.get(nextRideState, NEXT_RIDE_KEY) ?? {};
      if (rodeNextRide(next, payload)) {
        replace({}).catch((error: unknown) => ctx.logger.warn(`Could not clear the next ride: ${String(error)}`));
      }
    });
    const stored = await kept.read();
    // A next ride set while the document was read is newer.
    if (stored && !written) ctx.state.set(nextRideState, NEXT_RIDE_KEY, stored);
  },
});
