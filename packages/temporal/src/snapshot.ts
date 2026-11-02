// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TemporalSnapshot, TemporalValue } from '@ridrs/contracts';
import type { TemporalSeries } from './series.ts';

/**
 * All series evaluated at the same time `at`. A series without a writer is part of the snapshot
 * as unavailable - never left out.
 */
export function buildSnapshot(
  series: ReadonlyMap<string, TemporalSeries | undefined>,
  at: number,
  now: number,
  trigger?: { readonly series: string; readonly measuredAt: number },
): TemporalSnapshot {
  const values: Record<string, TemporalValue> = {};
  for (const [id, entry] of series) {
    values[id] = entry
      ? entry.valueAt(at, now)
      : { status: 'unavailable', at, reason: 'no-source' };
  }
  return trigger ? { at, trigger, values } : { at, values };
}
