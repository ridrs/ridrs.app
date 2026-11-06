// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Track } from './track.ts';

/** s of track time between two samples of the video time's table (ADR 0062). */
export const TIME_STEP = 0.5;

/**
 * σ (s) of the Gaussian kernel that smooths the track's distance over time (ADR 0062): wide
 * enough that the camera speed doesn't step at the GPX points, narrow enough that the picture
 * stays within a few metres of them.
 */
export const SMOOTHING = 4;

/** How far the kernel reaches either way, and how far the ends are extended: 4 σ, in samples. */
const REACH = Math.round((4 * SMOOTHING) / TIME_STEP);

/**
 * The route's distance over its video time, smoothed: `distances[i]` m at `i · TIME_STEP` s of
 * the track. It never decreases.
 */
export interface VideoTime {
  readonly distances: readonly number[];
}

/** The index of the last entry of an ascending list at or before `value`, or -1 before the first. */
function lastAtOrBefore(values: readonly number[], value: number): number {
  let low = -1;
  let high = values.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((values[middle] ?? 0) <= value) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

/** The track's distance at `time` s, linear between two points, as `placeAt` has the time. */
function distanceAt(track: Track, times: readonly number[], time: number): number {
  const i = Math.max(0, lastAtOrBefore(times, time));
  const from = times[i] ?? 0;
  const to = times[i + 1];
  const a = track.distances[i] ?? 0;
  const b = track.distances[i + 1];
  return to === undefined || b === undefined || to <= from ? a : a + ((b - a) * (time - from)) / (to - from);
}

/** The Gaussian kernel of σ = `SMOOTHING`, truncated at ±`REACH` samples and normalised. */
function gaussianKernel(): number[] {
  const weights = Array.from({ length: 2 * REACH + 1 }, (_, k) =>
    Math.exp(-0.5 * (((k - REACH) * TIME_STEP) / SMOOTHING) ** 2),
  );
  const sum = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => w / sum);
}

/**
 * The video time of a route (ADR 0062), built once per track: the track's distance sampled every
 * `TIME_STEP` s up to its last point, both ends extended by `REACH` samples with their average
 * slope over that span, so the speed doesn't fall towards the start and the end, then smoothed
 * with a Gaussian kernel. A positive kernel keeps a curve that never decreases from decreasing.
 */
export function buildVideoTime(track: Track): VideoTime {
  const times = track.points.map((point) => point.time);
  const count = Math.floor((times.at(-1) ?? 0) / TIME_STEP) + 1;
  const sampled = Array.from({ length: count }, (_, i) => distanceAt(track, times, i * TIME_STEP));
  const span = Math.min(REACH, count - 1);
  const first = sampled[0] ?? 0;
  const last = sampled[count - 1] ?? 0;
  const startSlope = span > 0 ? ((sampled[span] ?? 0) - first) / span : 0;
  const endSlope = span > 0 ? (last - (sampled[count - 1 - span] ?? 0)) / span : 0;
  const extended = [
    ...Array.from({ length: REACH }, (_, k) => first - startSlope * (REACH - k)),
    ...sampled,
    ...Array.from({ length: REACH }, (_, k) => last + endSlope * (k + 1)),
  ];
  const kernel = gaussianKernel();
  const distances = sampled.map((_, i) =>
    kernel.reduce((sum, weight, k) => sum + weight * (extended[i + k] ?? 0), 0),
  );
  return { distances };
}

/**
 * The video time of a distance (ADRs 0061, 0062): the smoothed track's time there plus where the
 * track starts in the video. The render clock shows the frame at this time for the presented
 * distance, so the picture moves exactly as far as the physics moved. Before the start it holds
 * at the first time, beyond the end at the last; where the camera stood still, it is the last
 * time at that distance: the ride goes on where the video moves again.
 */
export function videoTimeAt(table: VideoTime, distance: number, offset = 0): number {
  const { distances } = table;
  const i = lastAtOrBefore(distances, distance);
  if (i < 0) {
    return offset;
  }
  const from = distances[i] ?? 0;
  const to = distances[i + 1];
  const f = to === undefined || to <= from || distance <= from ? 0 : (distance - from) / (to - from);
  return (i + f) * TIME_STEP + offset;
}
