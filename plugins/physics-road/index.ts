// SPDX-License-Identifier: AGPL-3.0-or-later

import { configSnapshotCapability, definePlugin, physicsRoadCapability } from '@ridrs/contracts';
import { DEMO_COURSE, gradientAt } from './course.ts';

/** The road under the rider, from the built-in demo course; computes no forces. */
export default definePlugin({
  initialize(ctx) {
    ctx.capabilities.provide(physicsRoadCapability, {
      source: ctx.manifest.id,
      at: (distance) => ({ gradient: gradientAt(DEMO_COURSE, distance), origin: 'default' }),
    });
    ctx.capabilities.provide(configSnapshotCapability, {
      section: ctx.manifest.id,
      snapshot: () => ({ course: DEMO_COURSE.map((segment) => ({ ...segment })) }),
    });
  },
});
