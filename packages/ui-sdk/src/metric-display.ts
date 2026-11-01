// SPDX-License-Identifier: Apache-2.0

import type { MetricReading, MetricUnavailableReason } from '@ridrs/contracts';

export interface MetricDisplay {
  readonly status: 'available' | 'unavailable';
  /** Whole number (half up), or an en dash when no value can be shown. */
  readonly text: string;
  /** Human-readable reason when unavailable; absent before the first reading. */
  readonly reason?: string;
}

const EN_DASH = '–';

const REASON_LABELS: Record<MetricUnavailableReason, string> = {
  'no-source': 'no source',
  disconnected: 'disconnected',
  stale: 'no signal',
};

/** Display rules shared by all metric widgets: never show 0 or the last value for missing data. */
export function describeMetricReading(reading: MetricReading | undefined): MetricDisplay {
  if (!reading) {
    return { status: 'unavailable', text: EN_DASH };
  }
  if (reading.status === 'unavailable') {
    return { status: 'unavailable', text: EN_DASH, reason: REASON_LABELS[reading.reason] };
  }
  // Math.round rounds half up for the non-negative values metrics carry; `+ 0` turns -0 into 0.
  return { status: 'available', text: String(Math.round(reading.value) + 0) };
}
