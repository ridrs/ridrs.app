// SPDX-License-Identifier: Apache-2.0

import type { MetricReading, MetricUnavailableReason, MetricUnit } from '@ridrs/contracts';

export interface MetricDisplay {
  readonly status: 'available' | 'unavailable';
  /** The value rounded half up to its unit's precision, or an en dash when none can be shown. */
  readonly text: string;
  /** Human-readable reason when unavailable; absent before the first reading. */
  readonly reason?: string;
}

const EN_DASH = '–';

const REASON_LABELS: Record<MetricUnavailableReason, string> = {
  'no-source': 'no source',
  disconnected: 'disconnected',
  stale: 'no signal',
  'insufficient-data': 'warming up',
};

/** Decimals shown per unit. */
const PRECISION: Record<MetricUnit, number> = {
  W: 0,
  rpm: 0,
  bpm: 0,
  'W/bpm': 2,
};

/** Rounds half up in decimal (exponent notation avoids binary artifacts such as 1.005 -> 1.00). */
function formatHalfUp(value: number, decimals: number): string {
  const rounded = Math.round(Number(`${value}e${decimals}`));
  // `+ 0` turns -0 into 0.
  return (Number(`${rounded}e-${decimals}`) + 0).toFixed(decimals);
}

/** Display rules shared by all metric widgets: never show 0 or the last value for missing data. */
export function describeMetricReading(reading: MetricReading | undefined): MetricDisplay {
  if (!reading) {
    return { status: 'unavailable', text: EN_DASH };
  }
  if (reading.status === 'unavailable') {
    return { status: 'unavailable', text: EN_DASH, reason: REASON_LABELS[reading.reason] };
  }
  // Math.round rounds half up for the non-negative values metrics carry.
  return { status: 'available', text: formatHalfUp(reading.value, PRECISION[reading.unit]) };
}
