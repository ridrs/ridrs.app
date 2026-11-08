// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  activityAthleteEvent,
  configSnapshotCapability,
  definePlugin,
  type PluginContext,
  physicsRiderCapability,
  type RiderParameters,
} from '@ridrs/contracts';

/** A rider on the hoods. Labelled as defaults: nothing here is measured or configured. */
export const RIDER_DEFAULTS: RiderParameters = Object.freeze({
  mass: Object.freeze({ value: 75, origin: 'default' }),
  cdA: Object.freeze({ value: 0.32, origin: 'default' }),
});

/** The parameters in force: the defaults, or those of the athlete frozen for the ride. */
const parametersOf = new WeakMap<PluginContext, { current: RiderParameters }>();

/**
 * Rider parameters only; computes no forces. The mass is the weight of the athlete that the
 * activity session froze for the ride (`activity.athlete`, a lifecycle event, ADR 0075), the
 * default of 75 kg without a weight; the drag area stays the default.
 */
export default definePlugin({
  initialize(ctx) {
    const parameters = { current: RIDER_DEFAULTS };
    parametersOf.set(ctx, parameters);
    ctx.capabilities.provide(physicsRiderCapability, { parameters: () => parameters.current });
    ctx.capabilities.provide(configSnapshotCapability, {
      section: ctx.manifest.id,
      snapshot: () => ({
        mass: { ...parameters.current.mass },
        cdA: { ...parameters.current.cdA },
      }),
    });
  },

  start(ctx) {
    const parameters = parametersOf.get(ctx);
    if (!parameters) {
      return;
    }
    ctx.events.subscribe(activityAthleteEvent, ({ payload }) => {
      const weight = payload.athlete.weight;
      parameters.current = Object.freeze({
        mass:
          weight === undefined
            ? RIDER_DEFAULTS.mass
            : Object.freeze({ value: weight, origin: 'profile' as const }),
        cdA: RIDER_DEFAULTS.cdA,
      });
    });
  },
});
