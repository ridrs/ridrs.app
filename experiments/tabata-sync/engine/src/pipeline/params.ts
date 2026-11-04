// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from 'node:crypto';
import {
  AnalysisParamsSchema,
  type AnalysisParams,
  type ComponentVersions,
  type IntervalParams,
  IntervalParamsSchema,
} from '@tabata-sync/contracts';
import { DEFAULT_GRID_OPTIONS, INTERVAL_MODEL_VERSION } from '../intervals/grid.ts';
import { LANDMARK_VERSION } from '../fingerprint/landmarks.ts';
import { MARKERS_VERSION } from '../markers/markers.ts';
import { RHYTHM_VERSION } from '../rhythm/rhythm.ts';

export const ENGINE_VERSION = '0.3.0';

export const COMPONENT_VERSIONS: ComponentVersions = {
  features: '1.0.0',
  fingerprint: LANDMARK_VERSION,
  markers: MARKERS_VERSION,
  rhythm: RHYTHM_VERSION,
  intervals: INTERVAL_MODEL_VERSION,
};

export const DEFAULT_INTERVAL_PARAMS: IntervalParams = IntervalParamsSchema.parse({
  useSpeech: true,
  model: { ...DEFAULT_GRID_OPTIONS },
});

export const DEFAULT_PARAMS: AnalysisParams = {
  analysisSampleRate: 11025,
  features: { fftSize: 1024, hopSize: 128, melBands: 40, minHz: 30, maxHz: 5000 },
  fingerprint: {
    minHz: 150,
    maxHz: 4000,
    peaksPerSecond: 30,
    neighborhoodFrames: 8,
    neighborhoodBins: 6,
    minSpanFrames: 8,
    maxSpanFrames: 80,
    fanOut: 5,
  },
  markers: { regularIntervalSec: 2, noveltyWindowSec: 1, minSignificantGapSec: 0.5 },
  rhythm: {
    minBpm: 50,
    maxBpm: 220,
    windowSec: 8,
    hopSec: 2,
    tempoChangeThreshold: 0.04,
    minTempoSegmentSec: 8,
  },
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export function resolveParams(overrides: DeepPartial<AnalysisParams> = {}): AnalysisParams {
  const merged = structuredClone(DEFAULT_PARAMS) as Record<string, unknown>;
  for (const [key, value] of Object.entries(overrides)) {
    merged[key] =
      value && typeof value === 'object' ? { ...(merged[key] as object), ...value } : value;
  }
  return AnalysisParamsSchema.parse(merged);
}

/** Canonical JSON (sorted keys), so equal parameters always hash equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonicalJson(inner)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function paramsHash(params: AnalysisParams): string {
  return createHash('sha256').update(canonicalJson(params)).digest('hex').slice(0, 16);
}
