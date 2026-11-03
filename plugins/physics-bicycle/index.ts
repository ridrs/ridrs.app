// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type BicycleParameters,
  configSnapshotCapability,
  definePlugin,
  physicsBicycleCapability,
} from '@ridrs/contracts';

/** A road bicycle with good tyres. Labelled as defaults: nothing here is measured or configured. */
export const BICYCLE_DEFAULTS: BicycleParameters = Object.freeze({
  mass: Object.freeze({ value: 10, origin: 'default' }),
  rollingResistanceCoefficient: Object.freeze({ value: 0.004, origin: 'default' }),
});

/** Bicycle parameters only; computes no forces. */
export default definePlugin({
  initialize(ctx) {
    ctx.capabilities.provide(physicsBicycleCapability, { parameters: () => BICYCLE_DEFAULTS });
    ctx.capabilities.provide(configSnapshotCapability, {
      section: ctx.manifest.id,
      snapshot: () => ({
        mass: { ...BICYCLE_DEFAULTS.mass },
        rollingResistanceCoefficient: { ...BICYCLE_DEFAULTS.rollingResistanceCoefficient },
      }),
    });
  },
});
