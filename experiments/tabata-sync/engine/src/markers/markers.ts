// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  AnalysisParams,
  AudioMarker,
  FingerprintData,
  MarkerFeatures,
  RhythmAnalysis,
  SignificantMarkerType,
} from '@tabata-sync/contracts';
import type { FeatureFrames } from '../dsp/features.ts';
import { clamp01, mad, median, movingAverage, pickPeaks } from '../dsp/signal.ts';

export const MARKERS_VERSION = '1.2.0';

type MarkerParams = AnalysisParams['markers'];

const MAX_MARKER_HASHES = 64;
const DESCRIPTOR_RANGE_DB = 50;
const PAUSE_RELATIVE_DB = -25;
const MIN_PAUSE_SEC = 0.3;
const MIN_VOLUME_JUMP_DB = 4;
const MIN_SPECTRAL_NOVELTY = 0.04;
const MIN_PERCUSSION_LOG_RATIO = 0.4;
const DROP_LOW_BAND_RISE = 0.1;
/** Minimum summed excess (dB over all bands) above the local band ceilings for a transient. */
const MIN_TRANSIENT_EXCESS_DB = 24;

export interface MarkerSet {
  readonly regular: AudioMarker[];
  readonly significant: AudioMarker[];
}

/** Precomputed per-frame curves shared by both marker kinds. */
class MarkerContext {
  readonly frameRate: number;
  readonly frames: number;
  /** RMS smoothed in the power domain over 100 ms, in dB. */
  readonly smoothDb: Float32Array;
  readonly medianDb: number;

  constructor(
    readonly features: FeatureFrames,
    readonly fingerprint: FingerprintData,
  ) {
    this.frameRate = features.frameRate;
    this.frames = features.frames;
    const power = features.rmsDb.map((db) => 10 ** (db / 10));
    const smooth = movingAverage(power, Math.round(this.frameRate * 0.05));
    this.smoothDb = smooth.map((p) => 10 * Math.log10(p + 1e-10));
    this.medianDb = median(this.smoothDb);
  }

  frameOf(sec: number): number {
    return Math.max(0, Math.min(this.frames - 1, Math.round(sec * this.frameRate)));
  }

  /** Mean of a per-frame curve over `[from, to)` frames; `power` averages dB values as power. */
  mean(curve: Float32Array, from: number, to: number, power = false): number {
    const a = Math.max(0, from);
    const b = Math.min(this.frames, to);
    if (b <= a) return power ? -100 : 0;
    let sum = 0;
    for (let i = a; i < b; i++) sum += power ? 10 ** ((curve[i] as number) / 10) : (curve[i] as number);
    return power ? 10 * Math.log10(sum / (b - a) + 1e-10) : sum / (b - a);
  }

  /** Band-mean-removed log-mel profile: an EQ-sensitive but gain-invariant timbre summary. */
  descriptor(from: number, to: number): Float32Array {
    const bands = this.features.melBands;
    const profile = new Float32Array(bands);
    const a = Math.max(0, from);
    const b = Math.max(a + 1, Math.min(this.frames, to));
    // Average power, not dB: frames where a band is silent would otherwise pin it to the floor
    // regardless of gain.
    for (let frame = a; frame < b; frame++) {
      for (let band = 0; band < bands; band++) {
        profile[band] = (profile[band] as number) + 10 ** ((this.features.logMel[frame * bands + band] as number) / 10);
      }
    }
    for (let band = 0; band < bands; band++) profile[band] = 10 * Math.log10((profile[band] as number) / (b - a) + 1e-10);
    // Bands far below the strongest one hold noise and dither, which a gain change shifts.
    const floor = profile.reduce((max, v) => Math.max(max, v), Number.NEGATIVE_INFINITY) - DESCRIPTOR_RANGE_DB;
    for (let band = 0; band < bands; band++) profile[band] = Math.max(profile[band] as number, floor);
    const mean = profile.reduce((s, v) => s + v, 0) / bands;
    return profile.map((v) => v - mean);
  }

  featuresAt(from: number, to: number, strength?: number): MarkerFeatures {
    const rmsDb = this.mean(this.features.rmsDb, from, to, true);
    return {
      rmsDb,
      relativeDb: rmsDb - this.medianDb,
      spectralFlux: this.mean(this.features.flux, from, to),
      spectralCentroidHz: this.mean(this.features.centroidHz, from, to),
      lowBandRatio: clamp01(this.mean(this.features.lowBandRatio, from, to)),
      ...(strength !== undefined ? { strength } : {}),
    };
  }

  /** Up to `MAX_MARKER_HASHES` fingerprint hashes anchored in the window, evenly sampled. */
  hashes(from: number, to: number): Uint32Array {
    const { times, hashes } = this.fingerprint;
    const inside: number[] = [];
    for (let i = lowerBound(times, from); i < times.length && (times[i] as number) < to; i++) inside.push(hashes[i] as number);
    if (inside.length <= MAX_MARKER_HASHES) return Uint32Array.from(inside);
    const step = inside.length / MAX_MARKER_HASHES;
    return Uint32Array.from({ length: MAX_MARKER_HASHES }, (_, k) => inside[Math.floor(k * step)] as number);
  }
}

function lowerBound(sorted: Float32Array, value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((sorted[mid] as number) < value) low = mid + 1;
    else high = mid;
  }
  return low;
}

export function regularMarkers(context: MarkerContext, params: MarkerParams): AudioMarker[] {
  const markers: AudioMarker[] = [];
  const durationSec = context.features.durationSec;
  const halfWindow = params.regularIntervalSec / 2;
  const hashDensity: number[] = [];
  const raw: Array<{ timeSec: number; from: number; to: number; count: number }> = [];

  for (let timeSec = 0; timeSec < durationSec; timeSec += params.regularIntervalSec) {
    const from = context.frameOf(timeSec - halfWindow);
    const to = context.frameOf(timeSec + halfWindow);
    const { times } = context.fingerprint;
    const count = lowerBound(times, to) - lowerBound(times, from);
    raw.push({ timeSec, from, to, count });
    hashDensity.push(count);
  }
  const typicalCount = median(hashDensity) || 1;

  for (const { timeSec, from, to, count } of raw) {
    const features = context.featuresAt(from, to);
    // Near-silent windows carry little identity; sparse hashes make a window hard to re-find.
    const loudness = clamp01((features.relativeDb + 30) / 20);
    const density = clamp01(count / typicalCount);
    markers.push({
      kind: 'regular',
      type: 'regular',
      timeSec,
      relevance: density * loudness,
      confidence: clamp01(0.5 * loudness + 0.5 * density),
      features,
      descriptor: context.descriptor(from, to),
      hashes: context.hashes(from, to),
    });
  }
  return markers;
}

interface RawEvent {
  type: SignificantMarkerType;
  frame: number;
  durationFrames?: number;
  strength: number;
  /** Strength divided by the detection threshold; 1 means just detected. */
  margin: number;
}

/** Difference of a curve's mean after and before each frame, using windows of `w` frames. */
function stepCurve(context: MarkerContext, curve: Float32Array, w: number, power: boolean, log = false): Float32Array {
  const out = new Float32Array(context.frames);
  for (let t = w; t < context.frames - w; t++) {
    const before = context.mean(curve, t - w, t, power);
    const after = context.mean(curve, t, t + w, power);
    out[t] = log ? Math.log((after + 1e-3) / (before + 1e-3)) : after - before;
  }
  return out;
}

/**
 * Level change at each frame, required to hold for two windows on each side: the smallest
 * difference between the median levels of `[t, t+w)`, `[t+w, t+2w)` and `[t-w, t)`, `[t-2w, t-w)`.
 * Short bursts (a whistle, a single hit) therefore never count as volume steps.
 */
function levelSteps(context: MarkerContext, w: number): Float32Array {
  const out = new Float32Array(context.frames);
  const db = context.smoothDb;
  const level = (from: number) => median(db.subarray(Math.max(0, from), Math.min(context.frames, from + w)));
  const stride = 2;
  for (let t = w; t < context.frames - w; t += stride) {
    const before = [level(t - w), t - 2 * w >= 0 ? level(t - 2 * w) : level(t - w)];
    const after = [level(t), t + 2 * w <= context.frames ? level(t + w) : level(t)];
    const rise = Math.min(...after) - Math.max(...before);
    const fall = Math.min(...before) - Math.max(...after);
    const value = rise > 0 ? rise : fall > 0 ? -fall : 0;
    for (let k = 0; k < stride && t + k < context.frames; k++) out[t + k] = value;
  }
  return out;
}

/**
 * Change point of the level inside `[from, to)`: the split that minimizes the squared error of a
 * two-level step fit. Unlike the steepest slope it is not pulled towards single beats.
 */
function steepestChange(context: MarkerContext, from: number, to: number, sign: number): number {
  const db = context.smoothDb;
  const a = Math.max(0, from);
  const b = Math.min(context.frames, to);
  if (b - a < 4) return Math.round((a + b) / 2);
  let total = 0;
  let totalSquares = 0;
  for (let t = a; t < b; t++) {
    total += db[t] as number;
    totalSquares += (db[t] as number) ** 2;
  }
  let left = 0;
  let leftSquares = 0;
  let best = Math.round((a + b) / 2);
  let bestError = Number.POSITIVE_INFINITY;
  for (let t = a; t < b - 1; t++) {
    left += db[t] as number;
    leftSquares += (db[t] as number) ** 2;
    const nLeft = t - a + 1;
    const nRight = b - a - nLeft;
    if (nLeft < 2 || nRight < 2) continue;
    const right = total - left;
    const meanLeft = left / nLeft;
    const meanRight = right / nRight;
    if (sign * (meanRight - meanLeft) <= 0) continue;
    const error = leftSquares - nLeft * meanLeft ** 2 + (totalSquares - leftSquares) - nRight * meanRight ** 2;
    if (error < bestError) {
      bestError = error;
      best = t + 1;
    }
  }
  return best;
}

function volumeEvents(context: MarkerContext, w: number, minGap: number): RawEvent[] {
  const step = levelSteps(context, w);
  const threshold = Math.max(MIN_VOLUME_JUMP_DB, 4 * mad(step));
  const events: RawEvent[] = [];
  for (const sign of [1, -1]) {
    const directed = step.map((v) => v * sign);
    for (const peak of pickPeaks(directed, threshold, minGap)) {
      // The step curve peaks where the windows separate best, not where the level moves;
      // place the event on the best two-level step fit within one window either side.
      const frame = steepestChange(context, peak.index - w, peak.index + w, sign);
      const lowBefore = context.mean(context.features.lowBandRatio, frame - w, frame);
      const lowAfter = context.mean(context.features.lowBandRatio, frame, frame + w);
      const isDrop = sign > 0 && lowAfter - lowBefore > DROP_LOW_BAND_RISE;
      events.push({
        type: isDrop ? 'drop' : sign > 0 ? 'volume_increase' : 'volume_decrease',
        frame,
        strength: sign * peak.value,
        margin: peak.value / threshold,
      });
    }
  }
  return events;
}

function spectralEvents(context: MarkerContext, w: number, minGap: number): RawEvent[] {
  const novelty = new Float32Array(context.frames);
  const silent = context.medianDb + PAUSE_RELATIVE_DB;
  for (let t = w; t < context.frames - w; t += 2) {
    // Next to silence the spectrum is only noise; the pause marker covers that boundary.
    if (median(context.smoothDb.subarray(t - w, t)) < silent || median(context.smoothDb.subarray(t, t + w)) < silent) continue;
    const before = context.descriptor(t - w, t);
    const after = context.descriptor(t, t + w);
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < before.length; i++) {
      dot += (before[i] as number) * (after[i] as number);
      na += (before[i] as number) ** 2;
      nb += (after[i] as number) ** 2;
    }
    const value = na > 0 && nb > 0 ? 1 - dot / Math.sqrt(na * nb) : 0;
    novelty[t] = value;
    novelty[t + 1] = value;
  }
  const threshold = Math.max(MIN_SPECTRAL_NOVELTY, median(novelty) + 5 * mad(novelty));
  return pickPeaks(novelty, threshold, minGap).map((peak) => ({
    type: 'spectral_change' as const,
    frame: peak.index,
    strength: peak.value,
    margin: peak.value / threshold,
  }));
}

function percussionEvents(context: MarkerContext, w: number, minGap: number): RawEvent[] {
  const step = stepCurve(context, context.features.flux, w, false, true);
  const absolute = step.map(Math.abs);
  const threshold = Math.max(MIN_PERCUSSION_LOG_RATIO, 4 * mad(step));
  return pickPeaks(absolute, threshold, minGap).map((peak) => ({
    type: 'percussion_change' as const,
    frame: peak.index,
    strength: step[peak.index] as number,
    margin: peak.value / threshold,
  }));
}

function pauseEvents(context: MarkerContext): RawEvent[] {
  const events: RawEvent[] = [];
  // Relative to the track only, so a quieter copy of the same track yields the same pauses.
  const quiet = (db: number) => db < context.medianDb + PAUSE_RELATIVE_DB;
  const minFrames = Math.round(MIN_PAUSE_SEC * context.frameRate);
  let start = -1;
  for (let t = 0; t <= context.frames; t++) {
    const isQuiet = t < context.frames && quiet(context.smoothDb[t] as number);
    if (isQuiet && start < 0) start = t;
    if (!isQuiet && start >= 0) {
      if (t - start >= minFrames) {
        const depth = context.medianDb - context.mean(context.smoothDb, start, t, true);
        events.push({ type: 'pause', frame: start, durationFrames: t - start, strength: depth, margin: depth / -PAUSE_RELATIVE_DB });
      }
      start = -1;
    }
  }
  return events;
}

/**
 * Onsets that push some bands above anything those bands reach elsewhere within ±4 s
 * (excluding ±0.5 s around the onset itself): whistles, beeps, horns, whooshes. Drum hits and
 * melody notes recur within a few seconds and explain themselves. Levels are relative, so
 * gain changes do not matter.
 */
function transientEvents(context: MarkerContext, minGap: number): RawEvent[] {
  // Onsets from the largest single-band rise: a narrow-band beep barely moves the broadband flux.
  const { peakFlux: flux, logMel, melBands } = context.features;
  const blockFrames = Math.max(1, Math.round(context.frameRate / 8));
  const blocks = Math.ceil(context.frames / blockFrames);
  const blockMax = new Float32Array(blocks * melBands).fill(Number.NEGATIVE_INFINITY);
  for (let t = 0; t < context.frames; t++) {
    const block = Math.floor(t / blockFrames);
    for (let band = 0; band < melBands; band++) {
      const index = block * melBands + band;
      blockMax[index] = Math.max(blockMax[index] as number, logMel[t * melBands + band] as number);
    }
  }
  const outer = Math.round((4 * context.frameRate) / blockFrames);
  const inner = Math.ceil((0.5 * context.frameRate) / blockFrames);

  const center = median(flux);
  const onsets = pickPeaks(flux, center + 2 * mad(flux, center), Math.max(1, Math.round(0.08 * context.frameRate)));
  const events: RawEvent[] = [];
  for (const onset of onsets) {
    const home = Math.floor(onset.index / blockFrames);
    let excess = 0;
    for (let band = 0; band < melBands; band++) {
      let ceiling = Number.NEGATIVE_INFINITY;
      for (let block = Math.max(0, home - outer); block <= Math.min(blocks - 1, home + outer); block++) {
        if (Math.abs(block - home) > inner) ceiling = Math.max(ceiling, blockMax[block * melBands + band] as number);
      }
      let peak = Number.NEGATIVE_INFINITY;
      for (let t = onset.index; t <= Math.min(context.frames - 1, onset.index + 4); t++) {
        peak = Math.max(peak, logMel[t * melBands + band] as number);
      }
      if (Number.isFinite(ceiling)) excess += Math.max(0, peak - ceiling);
    }
    if (excess >= MIN_TRANSIENT_EXCESS_DB) {
      // A louder onset shortly after the sound began may have been picked; go back to where the
      // unusual bands first rise above a quarter of their final excess.
      const ceilings = Float32Array.from({ length: melBands }, (_, band) => {
        let ceiling = Number.NEGATIVE_INFINITY;
        for (let block = Math.max(0, home - outer); block <= Math.min(blocks - 1, home + outer); block++) {
          if (Math.abs(block - home) > inner) ceiling = Math.max(ceiling, blockMax[block * melBands + band] as number);
        }
        return ceiling;
      });
      const excessAt = (t: number) => {
        let sum = 0;
        for (let band = 0; band < melBands; band++) {
          const c = ceilings[band] as number;
          if (Number.isFinite(c)) sum += Math.max(0, (logMel[t * melBands + band] as number) - c);
        }
        return sum;
      };
      let frame = onset.index;
      const lookBack = Math.round(0.25 * context.frameRate);
      while (frame > Math.max(0, onset.index - lookBack) && excessAt(frame - 1) >= 0.25 * excess) frame--;
      events.push({ type: 'transient', frame, strength: excess, margin: excess / MIN_TRANSIENT_EXCESS_DB });
    }
  }
  return events.filter((event, k) => k === 0 || event.frame - (events[k - 1] as RawEvent).frame >= minGap);
}

function tempoEvents(context: MarkerContext, rhythm: RhythmAnalysis): RawEvent[] {
  return rhythm.tempoSegments.slice(1).map((segment, i) => {
    const previous = rhythm.tempoSegments[i];
    const change = previous ? segment.bpm / previous.bpm - 1 : 0;
    return {
      type: 'tempo_change' as const,
      frame: context.frameOf(segment.startSec),
      strength: change,
      margin: 1 + Math.abs(change) * 10,
    };
  });
}

export function significantMarkers(context: MarkerContext, rhythm: RhythmAnalysis, params: MarkerParams): AudioMarker[] {
  const w = Math.max(2, Math.round(params.noveltyWindowSec * context.frameRate));
  const minGap = Math.max(1, Math.round(params.minSignificantGapSec * context.frameRate));
  const events = [
    ...volumeEvents(context, w, Math.max(minGap, w)),
    ...spectralEvents(context, w, minGap),
    ...percussionEvents(context, Math.round(2 * context.frameRate), minGap),
    ...pauseEvents(context),
    ...transientEvents(context, minGap),
    ...tempoEvents(context, rhythm),
  ].sort((a, b) => a.frame - b.frame);

  return events.map((event) => {
    const from = event.frame - w;
    const to = event.frame + w;
    return {
      kind: 'significant',
      type: event.type,
      timeSec: event.frame / context.frameRate,
      ...(event.durationFrames !== undefined ? { durationSec: event.durationFrames / context.frameRate } : {}),
      relevance: clamp01(event.margin / 3),
      // Confidence rises from 0.5 at the threshold towards 1 at three times the threshold.
      confidence: clamp01(0.5 + (event.margin - 1) / 4),
      features: context.featuresAt(from, to, event.strength),
      descriptor: context.descriptor(from, to),
      hashes: context.hashes(from, to),
    };
  });
}

export function generateMarkers(
  features: FeatureFrames,
  fingerprint: FingerprintData,
  rhythm: RhythmAnalysis,
  params: MarkerParams,
): MarkerSet {
  const context = new MarkerContext(features, fingerprint);
  return { regular: regularMarkers(context, params), significant: significantMarkers(context, rhythm, params) };
}
