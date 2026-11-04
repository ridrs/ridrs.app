// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AnalysisParams, RhythmAnalysis, TempoCandidate, TempoSegment } from '@tabata-sync/contracts';
import type { FeatureFrames } from '../dsp/features.ts';
import { clamp01, median, movingAverage, parabolicOffset } from '../dsp/signal.ts';

export const RHYTHM_VERSION = '1.1.0';

type RhythmParams = AnalysisParams['rhythm'];

/** Prior on tempo: log-normal around 120 BPM, one octave wide. Breaks octave ties only mildly. */
const PRIOR_CENTER_BPM = 120;
const PRIOR_OCTAVES = 1;
/** Beat tracker tightness; higher keeps beat spacing closer to the local period. */
const TIGHTNESS = 100;
/** Beat-period multiples that support a tempo hypothesis: beat, half bar, bar. */
const BAR_MULTIPLES = [1, 2, 4] as const;

/** Onset strength with slow trends removed, scaled to unit standard deviation. */
export function onsetEnvelope(features: FeatureFrames): Float32Array {
  const trend = movingAverage(features.flux, Math.round(features.frameRate * 0.5));
  const envelope = new Float32Array(features.frames);
  let sumSquares = 0;
  for (let i = 0; i < envelope.length; i++) {
    const value = Math.max(0, (features.flux[i] as number) - (trend[i] as number));
    envelope[i] = value;
    sumSquares += value * value;
  }
  const std = Math.sqrt(sumSquares / Math.max(1, envelope.length)) || 1;
  for (let i = 0; i < envelope.length; i++) envelope[i] = (envelope[i] as number) / std;
  return envelope;
}

/** Normalized autocorrelation of `signal[start, end)` for lags `minLag..maxLag`. */
function autocorrelation(signal: Float32Array, start: number, end: number, minLag: number, maxLag: number): Float32Array {
  const acf = new Float32Array(maxLag + 2);
  let energy = 0;
  for (let i = start; i < end; i++) energy += (signal[i] as number) ** 2;
  if (energy === 0) return acf;
  for (let lag = Math.max(1, minLag - 1); lag <= maxLag + 1; lag++) {
    let sum = 0;
    for (let i = start; i + lag < end; i++) sum += (signal[i] as number) * (signal[i + lag] as number);
    acf[lag] = sum / energy;
  }
  return acf;
}

function tempoPrior(bpm: number): number {
  return Math.exp(-0.5 * (Math.log2(bpm / PRIOR_CENTER_BPM) / PRIOR_OCTAVES) ** 2);
}

interface LagPeak {
  readonly lag: number;
  readonly score: number;
}

function lagPeaks(scores: Float32Array, minLag: number, maxLag: number): LagPeak[] {
  const peaks: LagPeak[] = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    const value = scores[lag] as number;
    if (value > 0 && value >= (scores[lag - 1] as number) && value > (scores[lag + 1] as number)) {
      const offset = parabolicOffset(scores[lag - 1] as number, value, scores[lag + 1] as number);
      peaks.push({ lag: lag + offset, score: value });
    }
  }
  return peaks.sort((a, b) => b.score - a.score);
}

function relationTo(primaryBpm: number, bpm: number): TempoCandidate['relation'] {
  const ratio = bpm / primaryBpm;
  if (Math.abs(ratio - 0.5) < 0.03) return 'half';
  if (Math.abs(ratio - 2) < 0.06) return 'double';
  return 'other';
}

/**
 * Splits windowed tempo estimates into segments. A change is accepted only when it persists
 * for `minTempoSegmentSec`, so single noisy windows never create a segment.
 */
function segmentTempo(
  windowBpm: readonly number[],
  windowStarts: readonly number[],
  windowSec: number,
  durationSec: number,
  params: RhythmParams,
): Array<{ startSec: number; endSec: number; bpms: number[] }> {
  const persist = Math.max(1, Math.round(params.minTempoSegmentSec / params.hopSec));
  const segments: Array<{ startSec: number; endSec: number; bpms: number[] }> = [];
  let current = { startSec: 0, endSec: durationSec, bpms: [] as number[] };
  for (let w = 0; w < windowBpm.length; w++) {
    const bpm = windowBpm[w] as number;
    const reference = current.bpms.length > 0 ? median(current.bpms) : bpm;
    const deviates = (value: number) => Math.abs(value / reference - 1) > params.tempoChangeThreshold;
    const run = windowBpm.slice(w, w + persist);
    if (current.bpms.length >= persist && run.length === persist && run.every(deviates)) {
      // The change happens around the middle of the first deviating window.
      const boundary = (windowStarts[w] as number) + windowSec / 2;
      segments.push({ ...current, endSec: boundary });
      current = { startSec: boundary, endSec: durationSec, bpms: [] };
    }
    current.bpms.push(bpm);
  }
  segments.push(current);
  return segments;
}

/** Dynamic-programming beat tracker (Ellis 2007) with a period that may vary over time. */
function trackBeats(onset: Float32Array, periodAt: (frame: number) => number): number[] {
  const n = onset.length;
  const score = new Float64Array(n);
  const backlink = new Int32Array(n).fill(-1);
  for (let t = 0; t < n; t++) {
    const period = periodAt(t);
    const from = Math.max(0, Math.round(t - 2 * period));
    const to = Math.round(t - period / 2);
    let best = 0;
    let bestIndex = -1;
    for (let tau = from; tau <= to && tau < t; tau++) {
      const candidate = (score[tau] as number) - TIGHTNESS * Math.log((t - tau) / period) ** 2;
      if (bestIndex < 0 || candidate > best) {
        best = candidate;
        bestIndex = tau;
      }
    }
    score[t] = (onset[t] as number) + (bestIndex >= 0 ? best : 0);
    backlink[t] = bestIndex;
  }

  // Start the backtrace from the best-scoring frame within the last period.
  const lastPeriod = periodAt(n - 1);
  let end = n - 1;
  for (let t = Math.max(0, Math.round(n - lastPeriod)); t < n; t++) {
    if ((score[t] as number) > (score[end] as number)) end = t;
  }
  const beats: number[] = [];
  for (let t = end; t >= 0; t = backlink[t] as number) beats.push(t);
  beats.reverse();

  // Drop beats in leading and trailing silence, where the tracker only extrapolates.
  const threshold = 0.5 * Math.sqrt(beats.reduce((sum, b) => sum + localMax(onset, b) ** 2, 0) / Math.max(1, beats.length));
  let first = 0;
  let last = beats.length - 1;
  while (first <= last && localMax(onset, beats[first] as number) < threshold) first++;
  while (last >= first && localMax(onset, beats[last] as number) < threshold) last--;
  return beats.slice(first, last + 1);
}

function localMax(onset: Float32Array, frame: number, radius = 2): number {
  let max = 0;
  for (let i = Math.max(0, frame - radius); i <= Math.min(onset.length - 1, frame + radius); i++) {
    max = Math.max(max, onset[i] as number);
  }
  return max;
}

/** Least-squares beat period over a run of beat frames. */
function regressionPeriod(beatFrames: readonly number[]): number | null {
  if (beatFrames.length < 4) return null;
  const n = beatFrames.length;
  const meanIndex = (n - 1) / 2;
  const meanFrame = beatFrames.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  beatFrames.forEach((frame, i) => {
    sxy += (i - meanIndex) * (frame - meanFrame);
    sxx += (i - meanIndex) ** 2;
  });
  return sxy / sxx;
}

export function analyzeRhythm(features: FeatureFrames, params: RhythmParams): RhythmAnalysis {
  const frameRate = features.frameRate;
  const onset = onsetEnvelope(features);
  const durationSec = features.durationSec;
  const minLag = Math.max(2, Math.floor((60 * frameRate) / params.maxBpm));
  const maxLag = Math.ceil((60 * frameRate) / params.minBpm);
  const windowFrames = Math.round(params.windowSec * frameRate);
  const hopFrames = Math.round(params.hopSec * frameRate);

  // Tempogram: autocorrelation per window, averaged into a global tempo score.
  const windows: Float32Array[] = [];
  const windowStarts: number[] = [];
  for (let start = 0; start + windowFrames <= onset.length || windows.length === 0; start += hopFrames) {
    windows.push(autocorrelation(onset, start, Math.min(onset.length, start + windowFrames), minLag, maxLag));
    windowStarts.push(start / frameRate);
    if (start + windowFrames >= onset.length) break;
  }
  const global = new Float32Array(maxLag + 2);
  for (const acf of windows) for (let lag = 0; lag < global.length; lag++) global[lag] = (global[lag] as number) + (acf[lag] as number) / windows.length;
  // A true beat period also repeats at half-bar and bar level; spurious 2/3 or 4/3 periods do not.
  // Score each lag together with its multiples, from one autocorrelation over the whole track.
  const full = autocorrelation(onset, 0, onset.length, minLag, BAR_MULTIPLES.at(-1)! * maxLag);
  const weighted = global.map((_, lag) => {
    if (lag < minLag) return 0;
    let comb = 0;
    BAR_MULTIPLES.forEach((multiple, k) => {
      comb += (full[multiple * lag] ?? 0) * 0.5 ** k;
    });
    return Math.max(0, comb) * tempoPrior((60 * frameRate) / lag);
  });

  const peaks = lagPeaks(weighted, minLag, maxLag);
  if (peaks.length === 0) {
    return { bpm: 0, confidence: 0, alternatives: [], tempoSegments: [], beats: new Float64Array(), beatStrengths: new Float32Array() };
  }
  const primaryLag = (peaks[0] as LagPeak).lag;

  // Local tempo per window, constrained to ±20 % of the primary lag so octave jumps do not count as tempo changes.
  const windowBpm = windows.map((acf) => {
    const low = Math.max(minLag, Math.floor(primaryLag * 0.8));
    const high = Math.min(maxLag, Math.ceil(primaryLag * 1.2));
    const local = lagPeaks(acf, low, high)[0];
    return (60 * frameRate) / (local?.lag ?? primaryLag);
  });
  const smoothedBpm = windowBpm.map((_, i) => median(windowBpm.slice(Math.max(0, i - 1), i + 2)));
  const rawSegments = segmentTempo(smoothedBpm, windowStarts, params.windowSec, durationSec, params);

  const segmentPeriod = rawSegments.map((segment) => (60 * frameRate) / median(segment.bpms));
  const periodAt = (frame: number) => {
    const sec = frame / frameRate;
    const index = rawSegments.findIndex((segment) => sec < segment.endSec);
    return segmentPeriod[index < 0 ? segmentPeriod.length - 1 : index] as number;
  };
  const beatFrames = trackBeats(onset, periodAt);

  // Refine each segment's tempo from its tracked beats; this beats the lag resolution of the ACF.
  const tempoSegments: TempoSegment[] = rawSegments.map((segment, i) => {
    const inside = beatFrames.filter((frame) => frame / frameRate >= segment.startSec && frame / frameRate < segment.endSec);
    const period = regressionPeriod(inside) ?? (segmentPeriod[i] as number);
    const intervals = inside.slice(1).map((frame, k) => frame - (inside[k] as number));
    const spread = intervals.length > 1 ? median(intervals.map((v) => Math.abs(v - period))) / period : 1;
    return {
      startSec: segment.startSec,
      endSec: segment.endSec,
      bpm: (60 * frameRate) / period,
      confidence: clamp01(1 - 10 * spread),
    };
  });

  const longest = tempoSegments.reduce((a, b) => (b.endSec - b.startSec > a.endSec - a.startSec ? b : a));
  const primaryBpm = longest.bpm;
  const peakScore = (peaks[0] as LagPeak).score;
  const alternatives: TempoCandidate[] = [{ bpm: primaryBpm, score: 1, relation: 'primary' }];
  for (const peak of peaks.slice(1, 6)) {
    const bpm = (60 * frameRate) / peak.lag;
    if (Math.abs(bpm / primaryBpm - 1) < 0.03) continue;
    alternatives.push({ bpm, score: clamp01(peak.score / peakScore), relation: relationTo(primaryBpm, bpm) });
  }
  // Always offer the octave interpretations, scored from the unweighted autocorrelation.
  for (const [factor, relation] of [[0.5, 'half'], [2, 'double']] as const) {
    const bpm = primaryBpm * factor;
    if (alternatives.some((c) => c.relation === relation) || bpm < params.minBpm / 2 || bpm > params.maxBpm * 2) continue;
    const lag = Math.round((60 * frameRate) / bpm);
    const score = lag < global.length ? (global[lag] as number) / ((global[Math.round(primaryLag)] as number) || 1) : 0;
    alternatives.push({ bpm, score: clamp01(score), relation });
  }

  const typical = median(Array.from(global.subarray(minLag, maxLag + 1)));
  const prominence = clamp01(((global[Math.round(primaryLag)] as number) - typical) / Math.max(1e-6, global[Math.round(primaryLag)] as number));
  const strongest = beatFrames.reduce((max, frame) => Math.max(max, localMax(onset, frame)), 0) || 1;

  return {
    bpm: primaryBpm,
    confidence: clamp01(prominence * (0.5 + 0.5 * longest.confidence)),
    alternatives,
    tempoSegments,
    beats: Float64Array.from(beatFrames, (frame) => frame / frameRate),
    beatStrengths: Float32Array.from(beatFrames, (frame) => localMax(onset, frame) / strongest),
  };
}
