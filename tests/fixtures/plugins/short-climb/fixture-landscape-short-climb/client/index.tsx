// SPDX-License-Identifier: AGPL-3.0-or-later

import { uiTerrainObservedEvent } from '@ridrs/contracts';
import type { UiComponent } from '@ridrs/ui-sdk';

/** The e2e cannot ride 2 km in real time: flat for the first 20 m, then 5 % for ever. */
const FLAT_FOR = 20;
const CLIMB = 0.05;
/** One window long enough for any e2e ride, a sample every metre. */
const LENGTH = 2000;

/**
 * A landscape as a sensor and nothing else: when it is mounted for the ride it publishes one
 * window from 0 m, as ui-landscape-demo does, and draws nothing.
 */
export const ShortClimbLandscape: UiComponent = (container, ctx) => {
  container.dataset.testid = 'landscape-short-climb';
  ctx.events.publish(uiTerrainObservedEvent, {
    revision: 1,
    originDistance: 0,
    spacing: 1,
    samples: Array.from({ length: LENGTH + 1 }, (_, d) => ({
      gradient: d < FLAT_FOR ? 0 : CLIMB,
      surface: 'asphalt',
    })),
  });
};
