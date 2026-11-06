// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  activityEquipmentEvent,
  type BicycleParameters,
  configSnapshotCapability,
  definePlugin,
  type PluginContext,
  physicsBicycleCapability,
} from '@ridrs/contracts';

/** A road bicycle with good tyres. Labelled as defaults: nothing here is measured or configured. */
export const BICYCLE_DEFAULTS: BicycleParameters = Object.freeze({
  mass: Object.freeze({ value: 10, origin: 'default' }),
  rollingResistanceCoefficient: Object.freeze({ value: 0.004, origin: 'default' }),
});

/** The parameters in force: the defaults, or those of the bicycle frozen for the ride. */
const parametersOf = new WeakMap<PluginContext, { current: BicycleParameters }>();

/**
 * Bicycle parameters only; computes no forces. The mass is the bicycle's that the activity session
 * froze for the ride (`activity.equipment`, a lifecycle event, ADR 0060), the defaults without
 * one; the rolling resistance stays the default.
 */
export default definePlugin({
  initialize(ctx) {
    const parameters = { current: BICYCLE_DEFAULTS };
    parametersOf.set(ctx, parameters);
    ctx.capabilities.provide(physicsBicycleCapability, { parameters: () => parameters.current });
    ctx.capabilities.provide(configSnapshotCapability, {
      section: ctx.manifest.id,
      snapshot: () => ({
        mass: { ...parameters.current.mass },
        rollingResistanceCoefficient: { ...parameters.current.rollingResistanceCoefficient },
      }),
    });
  },

  start(ctx) {
    const parameters = parametersOf.get(ctx);
    if (!parameters) {
      return;
    }
    ctx.events.subscribe(activityEquipmentEvent, ({ payload }) => {
      parameters.current = Object.freeze({
        mass: Object.freeze({ value: payload.bicycle.mass, origin: 'equipment' as const }),
        rollingResistanceCoefficient: BICYCLE_DEFAULTS.rollingResistanceCoefficient,
      });
    });
  },
});
