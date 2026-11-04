// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from 'zod';

const unit = z.number().min(0).max(1);

// ---------------------------------------------------------------- fingerprints

/**
 * Speed-invariant landmark fingerprint. Arrays are parallel, one entry per peak triplet:
 * `hashes[i]` is the quantized triplet shape, `times[i]` the anchor peak time in frames,
 * `spans[i]` the first-to-last peak distance in frames and `pitches[i]` the anchor peak
 * on a log-frequency scale (semitones above 1 Hz).
 */
export interface FingerprintData {
  readonly algorithm: string;
  readonly version: string;
  /** Analysis frames per second; converts `times` and `spans` to seconds. */
  readonly frameRate: number;
  readonly hashes: Uint32Array;
  readonly times: Float32Array;
  readonly spans: Float32Array;
  readonly pitches: Float32Array;
}

/** Linear alignment `referenceTime = speedRatio * queryTime + offsetSec`, plus its support. */
export const AlignmentSchema = z.object({
  offsetSec: z.number(),
  speedRatio: z.number().positive(),
  pitchRatio: z.number().positive(),
  /** Hash hits consistent with the alignment line. */
  inliers: z.number().int().nonnegative(),
  /** Inliers relative to the smaller fingerprint's hash count. */
  similarity: unit,
  /** Covered query time span in seconds, from first to last inlier. */
  queryStartSec: z.number(),
  queryEndSec: z.number(),
  residualMs: z.number().nonnegative(),
});
export type Alignment = z.infer<typeof AlignmentSchema>;

export const MatchVerdictSchema = z.enum(['confident', 'probable', 'uncertain', 'unknown']);
export type MatchVerdict = z.infer<typeof MatchVerdictSchema>;

export const TransformationSchema = z.object({
  kind: z.enum([
    'gain',
    'speed',
    'pitch',
    'time_offset',
    'leading_silence',
    'trailing_silence',
    'trimmed_start',
    'trimmed_end',
    'local_modification',
  ]),
  value: z.number().optional(),
  startSec: z.number().optional(),
  endSec: z.number().optional(),
  confidence: unit,
});
export type Transformation = z.infer<typeof TransformationSchema>;

export const MatchSectionSchema = z.object({
  queryStartSec: z.number(),
  queryEndSec: z.number(),
  referenceStartSec: z.number().nullable(),
  referenceEndSec: z.number().nullable(),
  matched: z.boolean(),
});

export const MatchResultSchema = z.object({
  verdict: MatchVerdictSchema,
  trackId: z.string().optional(),
  variantId: z.string().optional(),
  similarity: unit,
  confidence: unit,
  offsetSec: z.number(),
  speedRatio: z.number().positive(),
  transformations: z.array(TransformationSchema),
  sections: z.array(MatchSectionSchema),
});
export type MatchResult = z.infer<typeof MatchResultSchema>;

// ---------------------------------------------------------------- markers

export const RegularMarkerTypeSchema = z.literal('regular');
export const SignificantMarkerTypeSchema = z.enum([
  'volume_increase',
  'volume_decrease',
  'pause',
  'spectral_change',
  'drop',
  'percussion_change',
  'tempo_change',
  'transient',
  'speech',
  'repeated_pattern',
]);
export type SignificantMarkerType = z.infer<typeof SignificantMarkerTypeSchema>;

/** Scalar features stored with every marker; descriptor vectors travel separately as binary. */
export const MarkerFeaturesSchema = z.object({
  rmsDb: z.number(),
  /** RMS relative to the track's median RMS, in dB. */
  relativeDb: z.number(),
  spectralFlux: z.number(),
  spectralCentroidHz: z.number(),
  lowBandRatio: unit,
  /** Event-specific magnitude, e.g. the dB change of a volume jump. */
  strength: z.number().optional(),
});
export type MarkerFeatures = z.infer<typeof MarkerFeaturesSchema>;

export interface AudioMarker {
  readonly kind: 'regular' | 'significant';
  readonly type: 'regular' | SignificantMarkerType;
  readonly timeSec: number;
  readonly durationSec?: number;
  readonly relevance: number;
  readonly confidence: number;
  readonly features: MarkerFeatures;
  /** Normalized log-mel band profile around the marker; gain-invariant. */
  readonly descriptor: Float32Array;
  /** Fingerprint hashes whose anchor lies inside the marker's window. */
  readonly hashes: Uint32Array;
}

// ---------------------------------------------------------------- rhythm

export const TempoCandidateSchema = z.object({
  bpm: z.number().positive(),
  score: unit,
  relation: z.enum(['primary', 'half', 'double', 'other']),
});
export type TempoCandidate = z.infer<typeof TempoCandidateSchema>;

export const TempoSegmentSchema = z.object({
  startSec: z.number(),
  endSec: z.number(),
  bpm: z.number().positive(),
  confidence: unit,
});
export type TempoSegment = z.infer<typeof TempoSegmentSchema>;

export interface RhythmAnalysis {
  readonly bpm: number;
  readonly confidence: number;
  readonly alternatives: readonly TempoCandidate[];
  readonly tempoSegments: readonly TempoSegment[];
  readonly beats: Float64Array;
  readonly beatStrengths: Float32Array;
}

// ---------------------------------------------------------------- analysis runs

export const AnalysisKindSchema = z.enum(['full', 'fingerprint', 'rhythm', 'markers', 'intervals']);
export type AnalysisKind = z.infer<typeof AnalysisKindSchema>;

export const AnalysisParamsSchema = z.object({
  analysisSampleRate: z.number().int().positive(),
  features: z.object({
    fftSize: z.number().int().positive(),
    hopSize: z.number().int().positive(),
    melBands: z.number().int().positive(),
    minHz: z.number().positive(),
    maxHz: z.number().positive(),
  }),
  /** The fingerprint reuses the feature spectrogram (`features.fftSize` / `hopSize`). */
  fingerprint: z.object({
    minHz: z.number().positive(),
    maxHz: z.number().positive(),
    peaksPerSecond: z.number().positive(),
    neighborhoodFrames: z.number().int().positive(),
    neighborhoodBins: z.number().int().positive(),
    minSpanFrames: z.number().int().positive(),
    maxSpanFrames: z.number().int().positive(),
    fanOut: z.number().int().positive(),
  }),
  markers: z.object({
    regularIntervalSec: z.number().positive(),
    noveltyWindowSec: z.number().positive(),
    minSignificantGapSec: z.number().nonnegative(),
  }),
  rhythm: z.object({
    minBpm: z.number().positive(),
    maxBpm: z.number().positive(),
    windowSec: z.number().positive(),
    hopSec: z.number().positive(),
    tempoChangeThreshold: z.number().positive(),
    minTempoSegmentSec: z.number().positive(),
  }),
});
export type AnalysisParams = z.infer<typeof AnalysisParamsSchema>;

export const ComponentVersionsSchema = z.record(z.string(), z.string());
export type ComponentVersions = z.infer<typeof ComponentVersionsSchema>;

/** Parameters of an interval detection run; hashed separately from the base analysis. */
export const IntervalParamsSchema = z.object({
  useSpeech: z.boolean(),
  /** Weights rank the evidence: countdown beats, then tonal cues, then volume. */
  model: z.object({
    countdownWeight: z.number().nonnegative(),
    cueWeight: z.number().nonnegative(),
    volumeWeight: z.number().nonnegative(),
    minIntervalSec: z.number().positive(),
    maxCycleSec: z.number().positive(),
    minRounds: z.number().int().min(1),
    minSignificance: z.number().nonnegative(),
  }),
});
export type IntervalParams = z.infer<typeof IntervalParamsSchema>;
