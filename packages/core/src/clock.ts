// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Clock } from '@ridrs/contracts';

export function createSystemClock(): Clock {
  return {
    now(): number {
      return Math.trunc(performance.timeOrigin + performance.now());
    },
  };
}
