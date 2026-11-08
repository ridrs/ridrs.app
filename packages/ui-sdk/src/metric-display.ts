// SPDX-License-Identifier: Apache-2.0

import type {
  Language,
  MetricReading,
  MetricUnavailableReason,
  MetricUnit,
} from '@ridrs/contracts';
import { type Catalogs, localizeNumber } from './language.ts';

export interface MetricDisplay {
  readonly status: 'available' | 'unavailable';
  /** The value rounded half up to its unit's precision, or an en dash when none can be shown. */
  readonly text: string;
  /** Human-readable reason when unavailable; absent before the first reading. */
  readonly reason?: string;
}

const EN_DASH = '–';

const REASON_LABELS: Catalogs<Record<MetricUnavailableReason, string>> = {
  en: {
    'no-source': 'no source',
    disconnected: 'disconnected',
    stale: 'no signal',
    'insufficient-data': 'warming up',
  },
  de: {
    'no-source': 'keine Quelle',
    disconnected: 'getrennt',
    stale: 'kein Signal',
    'insufficient-data': 'sammelt Daten',
  },
};

/** Decimals shown per unit. */
const PRECISION: Record<MetricUnit, number> = {
  W: 0,
  rpm: 0,
  bpm: 0,
  'W/bpm': 2,
};

/**
 * Formats a number with `decimals` decimals, rounded half up in decimal: shifting by exponent
 * notation avoids binary artifacts such as 1.005 -> 1.00. The one rounding rule for every widget.
 */
export function formatDecimal(value: number, decimals: number): string {
  // Values such as 1.5e-7 already print in exponent notation: shift their exponent instead.
  const [mantissa, exponent = '0'] = String(value).split('e');
  const rounded = Math.round(Number(`${mantissa}e${Number(exponent) + decimals}`));
  // `+ 0` turns -0 into 0.
  return (Number(`${rounded}e-${decimals}`) + 0).toFixed(decimals);
}

/**
 * Display rules shared by all metric widgets: never show 0 or the last value for missing data.
 * The reason and the decimal mark are in `language` (ADR 0072).
 */
export function describeMetricReading(
  reading: MetricReading | undefined,
  language: Language = 'en',
): MetricDisplay {
  if (!reading) {
    return { status: 'unavailable', text: EN_DASH };
  }
  if (reading.status === 'unavailable') {
    return {
      status: 'unavailable',
      text: EN_DASH,
      reason: REASON_LABELS[language][reading.reason],
    };
  }
  // Math.round rounds half up for the non-negative values metrics carry.
  return {
    status: 'available',
    text: localizeNumber(formatDecimal(reading.value, PRECISION[reading.unit]), language),
  };
}
