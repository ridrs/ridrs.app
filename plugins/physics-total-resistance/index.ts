// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  definePlugin,
  physicsResistanceCapability,
  physicsTotalResistanceCapability,
} from '@ridrs/contracts';
import { totalResistance } from './total-resistance.ts';

/** Sums every `physics.resistance` without knowing any of them; contributions stay inspectable. */
export default definePlugin({
  initialize(ctx) {
    ctx.capabilities.provide(physicsTotalResistanceCapability, {
      evaluate: (input) =>
        totalResistance(ctx.capabilities.getAll(physicsResistanceCapability), input),
    });
  },
});
