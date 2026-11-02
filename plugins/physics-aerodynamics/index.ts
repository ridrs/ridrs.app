// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  definePlugin,
  PhysicsStepError,
  physicsResistanceCapability,
  physicsRiderCapability,
} from '@ridrs/contracts';
import { aerodynamicDragForce } from './aerodynamics.ts';

/** Still air at sea level and 15 °C, until an environment provides air density and wind. */
export const AERODYNAMICS_DEFAULTS = Object.freeze({ airDensity: 1.225 });

/** Drag of rider and bicycle together (one CdA), so their interaction is never counted twice. */
export default definePlugin({
  initialize(ctx) {
    const source = ctx.manifest.id;
    ctx.capabilities.provide(physicsResistanceCapability, {
      source,
      force: ({ speed }) => {
        const cdA = ctx.capabilities.get(physicsRiderCapability).parameters().cdA.value;
        if (!Number.isFinite(cdA) || cdA <= 0) {
          throw new PhysicsStepError(`Invalid CdA ${cdA}`, { pluginId: source });
        }
        return aerodynamicDragForce(AERODYNAMICS_DEFAULTS.airDensity, cdA, speed);
      },
    });
  },
});
