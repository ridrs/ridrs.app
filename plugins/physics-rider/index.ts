// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  configSnapshotCapability,
  definePlugin,
  physicsRiderCapability,
  type RiderParameters,
} from '@ridrs/contracts';

/** A rider on the hoods. Labelled as defaults: nothing here is measured or configured. */
export const RIDER_DEFAULTS: RiderParameters = Object.freeze({
  mass: Object.freeze({ value: 75, origin: 'default' }),
  cdA: Object.freeze({ value: 0.32, origin: 'default' }),
});

/** Rider parameters only; computes no forces. */
export default definePlugin({
  initialize(ctx) {
    ctx.capabilities.provide(physicsRiderCapability, { parameters: () => RIDER_DEFAULTS });
    ctx.capabilities.provide(configSnapshotCapability, {
      section: ctx.manifest.id,
      snapshot: () => ({ mass: { ...RIDER_DEFAULTS.mass }, cdA: { ...RIDER_DEFAULTS.cdA } }),
    });
  },
});
