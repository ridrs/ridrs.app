// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  definePlugin,
  PhysicsStepError,
  physicsEnvironmentCapability,
  physicsResistanceCapability,
  physicsRiderCapability,
} from '@ridrs/contracts';
import { aerodynamicDragForce } from './aerodynamics.ts';

/**
 * Drag of rider and bicycle together (one CdA), so their interaction is never counted twice.
 * Air density comes from the environment; there is no fallback of its own.
 */
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
        const airDensity = ctx.capabilities.get(physicsEnvironmentCapability).parameters()
          .airDensity.value;
        if (!Number.isFinite(airDensity) || airDensity <= 0) {
          throw new PhysicsStepError(`Invalid air density ${airDensity}`, { pluginId: source });
        }
        // Still air: the relative airflow is the speed.
        return aerodynamicDragForce(airDensity, cdA, speed);
      },
    });
  },
});
