// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  definePlugin,
  PhysicsStepError,
  physicsBicycleCapability,
  physicsResistanceCapability,
} from '@ridrs/contracts';
import { rollingResistanceForce } from './rolling-resistance.ts';

/** Rolling resistance of the bicycle's tyres on a flat road. */
export default definePlugin({
  initialize(ctx) {
    const source = ctx.manifest.id;
    ctx.capabilities.provide(physicsResistanceCapability, {
      source,
      force: ({ speed, mass }) => {
        const crr = ctx.capabilities.get(physicsBicycleCapability).parameters()
          .rollingResistanceCoefficient.value;
        if (!Number.isFinite(crr) || crr < 0) {
          throw new PhysicsStepError(`Invalid rolling resistance coefficient ${crr}`, {
            pluginId: source,
          });
        }
        return rollingResistanceForce(crr, mass, speed);
      },
    });
  },
});
