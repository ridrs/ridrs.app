// SPDX-License-Identifier: AGPL-3.0-or-later

import { definePlugin, physicsResistanceCapability } from '@ridrs/contracts';
import { gravityResistanceForce } from './gravity-resistance.ts';

/** The gradient force along the road. Mass and road come in the input; it reads no provider. */
export default definePlugin({
  initialize(ctx) {
    ctx.capabilities.provide(physicsResistanceCapability, {
      source: ctx.manifest.id,
      force: ({ mass, road }) => gravityResistanceForce(mass, road.gradient),
    });
  },
});
