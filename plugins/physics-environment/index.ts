// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  definePlugin,
  type EnvironmentParameters,
  physicsEnvironmentCapability,
} from '@ridrs/contracts';

/** Still air at sea level and 15 °C. Labelled as a default: nothing here is measured. */
export const ENVIRONMENT_DEFAULTS: EnvironmentParameters = Object.freeze({
  airDensity: Object.freeze({ value: 1.225, origin: 'default' }),
});

/** Environment parameters only; computes no forces. */
export default definePlugin({
  initialize(ctx) {
    ctx.capabilities.provide(physicsEnvironmentCapability, {
      parameters: () => ENVIRONMENT_DEFAULTS,
    });
  },
});
