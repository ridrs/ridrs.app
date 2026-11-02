// SPDX-License-Identifier: AGPL-3.0-or-later

import { definePlugin, physicsRoadCapability } from '@ridrs/contracts';

/** The e2e cannot ride 2 km in real time: flat for the first 20 m, then 5 % for ever. */
const FLAT_FOR = 20;
const CLIMB = 0.05;

export default definePlugin({
  initialize(ctx) {
    ctx.capabilities.provide(physicsRoadCapability, {
      source: ctx.manifest.id,
      at: (distance) => ({ gradient: distance < FLAT_FOR ? 0 : CLIMB, origin: 'default' }),
    });
  },
});
