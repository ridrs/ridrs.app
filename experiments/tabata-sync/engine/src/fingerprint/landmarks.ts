// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AnalysisParams, FingerprintData } from '@tabata-sync/contracts';
import { hzToBin, binToHz, type Spectrogram } from '../dsp/spectrogram.ts';
import { median, parabolicOffset, slidingMax } from '../dsp/signal.ts';

export const LANDMARK_ALGORITHM = 'landmark-triplet';
export const LANDMARK_VERSION = '1.0.0';

/** A spectral peak with sub-frame time and sub-bin frequency. */
export interface SpectralPeak {
  readonly time: number;
  /** Semitones above 1 Hz: `12 * log2(hz)`. */
  readonly pitch: number;
  readonly prominence: number;
}

const DB_FLOOR = -90;
/** Frames this far below the track's median level are treated as silence (noise, dither). */
const SILENCE_BELOW_MEDIAN_DB = 35;
const MIN_PROMINENCE_DB = 3;
const RATIO_LEVELS = 12;
const MAX_INTERVAL_SEMITONES = 24;
const BAND_SEMITONES = 6;

/**
 * Local maxima of the log spectrogram in a time–frequency neighborhood, thinned to a fixed
 * density per second by prominence over the frame's mean level. Both criteria are relative,
 * so gain, normalization, EQ and compression change the result very little.
 */
export function findSpectralPeaks(
  spectrogram: Spectrogram,
  params: AnalysisParams['fingerprint'],
): SpectralPeak[] {
  const { frames, bins, power, frameRate } = spectrogram;
  const lowBin = Math.max(1, Math.floor(hzToBin(params.minHz, spectrogram)));
  const highBin = Math.min(bins - 2, Math.ceil(hzToBin(params.maxHz, spectrogram)));
  const width = highBin - lowBin + 1;

  const db = new Float32Array(frames * width);
  const frameMean = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0;
    for (let k = 0; k < width; k++) {
      const p = power[frame * bins + lowBin + k] as number;
      db[frame * width + k] = 10 * Math.log10(p + 1e-10);
      sum += p;
    }
    // Level of the mean power, not the mean of dB values: it scales exactly with gain even
    // when most bins hold only noise.
    frameMean[frame] = 10 * Math.log10(sum / width + 1e-10);
  }
  const silence = Math.max(DB_FLOOR, median(frameMean) - SILENCE_BELOW_MEDIAN_DB);
  // Remove each frame's broadband level so that compression and gain riding, which scale whole
  // frames, cannot move the time position of a peak. Silent frames stay below the floor.
  for (let frame = 0; frame < frames; frame++) {
    const mean = frameMean[frame] as number;
    if (mean < silence) continue;
    for (let k = 0; k < width; k++) db[frame * width + k] = (db[frame * width + k] as number) - mean;
  }

  // Separable 2-D maximum filter: along frequency per frame, then along time per bin.
  const maxFreq = new Float32Array(frames * width);
  for (let frame = 0; frame < frames; frame++) {
    maxFreq.set(slidingMax(db.subarray(frame * width, (frame + 1) * width), params.neighborhoodBins), frame * width);
  }
  const column = new Float32Array(frames);
  const max2d = new Float32Array(frames * width);
  for (let k = 0; k < width; k++) {
    for (let frame = 0; frame < frames; frame++) column[frame] = maxFreq[frame * width + k] as number;
    const filtered = slidingMax(column, params.neighborhoodFrames);
    for (let frame = 0; frame < frames; frame++) max2d[frame * width + k] = filtered[frame] as number;
  }

  const at = (frame: number, k: number) => db[frame * width + k] as number;
  const blockFrames = Math.max(1, Math.round(frameRate));
  const perBlock = Math.max(1, Math.round(params.peaksPerSecond));
  const peaks: SpectralPeak[] = [];

  for (let blockStart = 1; blockStart < frames - 1; blockStart += blockFrames) {
    const block: SpectralPeak[] = [];
    const blockEnd = Math.min(frames - 1, blockStart + blockFrames);
    for (let frame = blockStart; frame < blockEnd; frame++) {
      for (let k = 1; k < width - 1; k++) {
        const value = at(frame, k);
        if ((frameMean[frame] as number) < silence || value !== max2d[frame * width + k]) continue;
        const prominence = value;
        if (prominence < MIN_PROMINENCE_DB) continue;
        const dt = parabolicOffset(at(frame - 1, k), value, at(frame + 1, k));
        const dk = parabolicOffset(at(frame, k - 1), value, at(frame, k + 1));
        const hz = binToHz(lowBin + k + dk, spectrogram);
        block.push({ time: frame + dt, pitch: 12 * Math.log2(hz), prominence });
      }
    }
    block.sort((a, b) => b.prominence - a.prominence);
    peaks.push(...block.slice(0, perBlock));
  }
  return peaks.sort((a, b) => a.time - b.time);
}

/**
 * Hash of a peak triplet. Uses only quantities that survive playback speed changes:
 * the time ratio `(t2 - t1) / (t3 - t1)`, pitch intervals between the peaks, and a coarse
 * pitch band of the anchor (tolerates about ±3 % resampling before flipping band).
 */
export function tripletHash(p1: SpectralPeak, p2: SpectralPeak, p3: SpectralPeak): number | null {
  const d12 = Math.round(p2.pitch - p1.pitch);
  const d13 = Math.round(p3.pitch - p1.pitch);
  if (Math.abs(d12) > MAX_INTERVAL_SEMITONES || Math.abs(d13) > MAX_INTERVAL_SEMITONES) return null;
  const ratio = (p2.time - p1.time) / (p3.time - p1.time);
  const ratioLevel = Math.min(RATIO_LEVELS - 1, Math.floor(ratio * RATIO_LEVELS));
  const band = Math.max(0, Math.min(31, Math.floor(p1.pitch / BAND_SEMITONES)));
  return (
    ((band << 16) | ((d12 + MAX_INTERVAL_SEMITONES) << 10) | ((d13 + MAX_INTERVAL_SEMITONES) << 4) | ratioLevel) >>> 0
  );
}

export function buildFingerprint(
  peaks: readonly SpectralPeak[],
  frameRate: number,
  params: AnalysisParams['fingerprint'],
): FingerprintData {
  const hashes: number[] = [];
  const times: number[] = [];
  const spans: number[] = [];
  const pitches: number[] = [];

  for (let i = 0; i < peaks.length; i++) {
    const anchor = peaks[i] as SpectralPeak;
    // Target zone: the next `fanOut` peaks after a short gap, within the maximum span.
    const zone: SpectralPeak[] = [];
    for (let j = i + 1; j < peaks.length && zone.length < params.fanOut; j++) {
      const peak = peaks[j] as SpectralPeak;
      const dt = peak.time - anchor.time;
      if (dt > params.maxSpanFrames) break;
      if (dt >= 1 && Math.abs(peak.pitch - anchor.pitch) <= MAX_INTERVAL_SEMITONES) zone.push(peak);
    }
    for (let a = 0; a < zone.length; a++) {
      for (let b = a + 1; b < zone.length; b++) {
        const p2 = zone[a] as SpectralPeak;
        const p3 = zone[b] as SpectralPeak;
        const span = p3.time - anchor.time;
        if (span < params.minSpanFrames || p3.time - p2.time < 1) continue;
        const hash = tripletHash(anchor, p2, p3);
        if (hash === null) continue;
        hashes.push(hash);
        times.push(anchor.time);
        spans.push(span);
        pitches.push(anchor.pitch);
      }
    }
  }

  return {
    algorithm: LANDMARK_ALGORITHM,
    version: LANDMARK_VERSION,
    frameRate,
    hashes: Uint32Array.from(hashes),
    times: Float32Array.from(times),
    spans: Float32Array.from(spans),
    pitches: Float32Array.from(pitches),
  };
}

export function extractFingerprint(
  spectrogram: Spectrogram,
  params: AnalysisParams['fingerprint'],
): FingerprintData {
  return buildFingerprint(findSpectralPeaks(spectrogram, params), spectrogram.frameRate, params);
}
