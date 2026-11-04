// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Alignment, FingerprintData } from '@tabata-sync/contracts';
import { median } from '../dsp/signal.ts';

export interface AlignOptions {
  /** Largest playback speed deviation searched, as a ratio (0.08 = ±8 %). */
  readonly maxSpeedDeviation: number;
  readonly speedStep: number;
  /** Offset histogram bin width in frames. */
  readonly offsetBinFrames: number;
  /** Maximum distance from the alignment line for a hit to count as inlier, in frames. */
  readonly inlierToleranceFrames: number;
  /** Only query anchors inside this window take part (seconds); used for section matching. */
  readonly queryWindow?: { readonly startSec: number; readonly endSec: number };
}

export const DEFAULT_ALIGN_OPTIONS: AlignOptions = {
  maxSpeedDeviation: 0.08,
  speedStep: 0.002,
  offsetBinFrames: 8,
  inlierToleranceFrames: 2.5,
};

/** Hash → indices into a fingerprint's arrays. */
export class HashTable {
  private readonly table = new Map<number, number[]>();

  constructor(readonly fingerprint: FingerprintData) {
    fingerprint.hashes.forEach((hash, index) => {
      const bucket = this.table.get(hash);
      if (bucket) bucket.push(index);
      else this.table.set(hash, [index]);
    });
  }

  lookup(hash: number): readonly number[] | undefined {
    return this.table.get(hash);
  }
}

interface Hit {
  readonly queryTime: number;
  readonly referenceTime: number;
  readonly pitchDelta: number;
  readonly queryIndex: number;
}

/**
 * Finds the best line `referenceTime = speedRatio * queryTime + offset` through all hash hits.
 * Each hit's span ratio limits the speeds it votes for, so a 2-D Hough vote over
 * (speed, offset) stays cheap; inliers of the winning cell are then refined by least squares.
 * Returns null when no cell collects at least `minInliers` consistent hits.
 */
export function alignFingerprints(
  query: FingerprintData,
  reference: FingerprintData | HashTable,
  options: AlignOptions = DEFAULT_ALIGN_OPTIONS,
  minInliers = 8,
): Alignment | null {
  const table = reference instanceof HashTable ? reference : new HashTable(reference);
  const ref = table.fingerprint;
  if (Math.abs(ref.frameRate - query.frameRate) > 1e-6) {
    throw new Error('Fingerprints with different frame rates cannot be aligned');
  }
  const frameRate = query.frameRate;
  const window = options.queryWindow;
  const inWindow = (index: number) => {
    if (!window) return true;
    const sec = (query.times[index] as number) / frameRate;
    return sec >= window.startSec && sec < window.endSec;
  };

  const speedSteps = Math.round(options.maxSpeedDeviation / options.speedStep);
  const speedCount = 2 * speedSteps + 1;
  const speedAt = (i: number) => 1 + (i - speedSteps) * options.speedStep;

  // Center query time so that speed errors smear offsets as little as possible.
  let queryMin = Number.POSITIVE_INFINITY;
  let queryMax = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < query.times.length; i++) {
    if (!inWindow(i)) continue;
    queryMin = Math.min(queryMin, query.times[i] as number);
    queryMax = Math.max(queryMax, query.times[i] as number);
  }
  if (!Number.isFinite(queryMin)) return null;
  const queryCenter = (queryMin + queryMax) / 2;
  const refMax = ref.times.reduce((max, t) => Math.max(max, t), 0);
  const offsetMin = -(queryMax - queryCenter) * (1 + options.maxSpeedDeviation) - 1;
  const offsetMax = refMax + (queryCenter - queryMin) * (1 + options.maxSpeedDeviation) + 1;
  const offsetBins = Math.ceil((offsetMax - offsetMin) / options.offsetBinFrames) + 1;
  const votes = new Uint16Array(speedCount * offsetBins);

  const forEachHit = (visit: (hit: Hit, scale: number, querySpan: number) => void) => {
    for (let q = 0; q < query.hashes.length; q++) {
      if (!inWindow(q)) continue;
      const bucket = table.lookup(query.hashes[q] as number);
      if (!bucket) continue;
      const querySpan = query.spans[q] as number;
      for (const r of bucket) {
        const scale = (ref.spans[r] as number) / querySpan;
        if (Math.abs(scale - 1) > options.maxSpeedDeviation * 1.5) continue;
        visit(
          {
            queryTime: query.times[q] as number,
            referenceTime: ref.times[r] as number,
            pitchDelta: (ref.pitches[r] as number) - (query.pitches[q] as number),
            queryIndex: q,
          },
          scale,
          querySpan,
        );
      }
    }
  };

  forEachHit((hit, scale, querySpan) => {
    // Interpolated peak times are good to about ±0.4 frames, so the span ratio is too.
    const tolerance = Math.max(2 * options.speedStep, 0.8 / querySpan);
    const first = Math.max(0, Math.ceil((scale - tolerance - 1) / options.speedStep) + speedSteps);
    const last = Math.min(speedCount - 1, Math.floor((scale + tolerance - 1) / options.speedStep) + speedSteps);
    const centered = hit.queryTime - queryCenter;
    for (let s = first; s <= last; s++) {
      const offset = hit.referenceTime - speedAt(s) * centered;
      const bin = Math.floor((offset - offsetMin) / options.offsetBinFrames);
      const cell = s * offsetBins + bin;
      if (bin >= 0 && bin < offsetBins && (votes[cell] as number) < 65535) votes[cell] = (votes[cell] as number) + 1;
    }
  });

  // Best cell, scored with its offset neighbors so that a line straddling two bins is not split.
  let bestScore = 0;
  let bestCell = -1;
  for (let s = 0; s < speedCount; s++) {
    for (let b = 0; b < offsetBins; b++) {
      const cell = s * offsetBins + b;
      const score =
        (votes[cell] as number) + 0.5 * ((b > 0 ? (votes[cell - 1] as number) : 0) + (b + 1 < offsetBins ? (votes[cell + 1] as number) : 0));
      if (score > bestScore) {
        bestScore = score;
        bestCell = cell;
      }
    }
  }
  if (bestCell < 0 || bestScore < minInliers) return null;

  let speed = speedAt(Math.floor(bestCell / offsetBins));
  let offset = offsetMin + ((bestCell % offsetBins) + 0.5) * options.offsetBinFrames - speed * queryCenter;
  let tolerance = options.offsetBinFrames;
  let inliers: Hit[] = [];

  for (let iteration = 0; iteration < 4; iteration++) {
    // Keep the closest hit per query triplet so repeated musical patterns are not double counted.
    const best = new Map<number, { hit: Hit; error: number }>();
    forEachHit((hit) => {
      const error = Math.abs(hit.referenceTime - (speed * hit.queryTime + offset));
      if (error > tolerance) return;
      const previous = best.get(hit.queryIndex);
      if (!previous || error < previous.error) best.set(hit.queryIndex, { hit, error });
    });
    inliers = [...best.values()].map((entry) => entry.hit);
    if (inliers.length < 2) return null;
    const [fittedSpeed, fittedOffset] = fitLine(inliers);
    // A short inlier run cannot pin the slope; keep the voted speed then.
    if (Math.abs(fittedSpeed - 1) <= options.maxSpeedDeviation) {
      speed = fittedSpeed;
      offset = fittedOffset;
    }
    tolerance = Math.max(options.inlierToleranceFrames, tolerance / 2);
  }
  if (inliers.length < minInliers) return null;

  let squared = 0;
  let queryStart = Number.POSITIVE_INFINITY;
  let queryEnd = Number.NEGATIVE_INFINITY;
  for (const hit of inliers) {
    squared += (hit.referenceTime - (speed * hit.queryTime + offset)) ** 2;
    queryStart = Math.min(queryStart, hit.queryTime);
    queryEnd = Math.max(queryEnd, hit.queryTime);
  }
  const pitchShift = median(inliers.map((hit) => hit.pitchDelta));
  const queryCount = window ? query.times.filter((_, i) => inWindow(i)).length : query.hashes.length;

  return {
    offsetSec: offset / frameRate,
    speedRatio: speed,
    // Positive pitch shift means the query sounds higher than the reference.
    pitchRatio: 2 ** (-pitchShift / 12),
    inliers: inliers.length,
    similarity: Math.min(1, inliers.length / Math.max(1, Math.min(queryCount, ref.hashes.length))),
    queryStartSec: queryStart / frameRate,
    queryEndSec: queryEnd / frameRate,
    residualMs: (Math.sqrt(squared / inliers.length) / frameRate) * 1000,
  };
}

/** Ordinary least squares `referenceTime = a * queryTime + b`. */
function fitLine(hits: readonly Hit[]): [number, number] {
  let sx = 0;
  let sy = 0;
  for (const hit of hits) {
    sx += hit.queryTime;
    sy += hit.referenceTime;
  }
  const mx = sx / hits.length;
  const my = sy / hits.length;
  let sxx = 0;
  let sxy = 0;
  for (const hit of hits) {
    sxx += (hit.queryTime - mx) ** 2;
    sxy += (hit.queryTime - mx) * (hit.referenceTime - my);
  }
  const a = sxx > 0 ? sxy / sxx : 1;
  return [a, my - a * mx];
}
