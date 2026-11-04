// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  configSnapshotCapability,
  definePlugin,
  PhysicsStepError,
  physicsBicycleCapability,
  physicsResistanceCapability,
} from '@ridrs/contracts';
import { ROLLING_DEFAULTS, rollingResistanceForce, surfaceCoefficient } from './rolling-resistance.ts';

/**
 * Rolling resistance of the bicycle's tyres, scaled by the surface; the road comes in the input,
 * never queried.
 */
export default definePlugin({
  initialize(ctx) {
    const source = ctx.manifest.id;
    ctx.capabilities.provide(configSnapshotCapability, {
      section: source,
      snapshot: () => ({ surfaceFactors: { ...ROLLING_DEFAULTS.surfaceFactors } }),
    });
    ctx.capabilities.provide(physicsResistanceCapability, {
      source,
      force: ({ speed, mass, road }) => {
        const crr = ctx.capabilities.get(physicsBicycleCapability).parameters()
          .rollingResistanceCoefficient.value;
        if (!Number.isFinite(crr) || crr < 0) {
          throw new PhysicsStepError(`Invalid rolling resistance coefficient ${crr}`, {
            pluginId: source,
          });
        }
        return rollingResistanceForce(surfaceCoefficient(crr, road.surface), mass, speed, road.gradient);
      },
    });
  },
});
