// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import type { TrackPoint } from './library.ts';
import { buildVideoTime, SMOOTHING, TIME_STEP, videoTimeAt } from './playback.ts';
import { buildTrack } from './track.ts';

// 1111.95 m due north, filmed in 100 s.
const TRACK = buildTrack([
  { latitude: 45, longitude: 5, elevation: 100, time: 0 },
  { latitude: 45.01, longitude: 5, elevation: 100, time: 100 },
]);
const TABLE = buildVideoTime(TRACK);

/** 0.0001° of latitude: about 11.1 m on the meridian. */
const STEP = 0.0001;

/** Points due north, one per entry of `times`, `steps[i]` × 0.0001° from the first. */
const northbound = (times: readonly number[], steps: readonly number[]): TrackPoint[] =>
  times.map((time, i) => ({ latitude: 45 + (steps[i] ?? 0) * STEP, longitude: 5, elevation: 100, time }));

describe('videoTimeAt', () => {
  it('is the track time of the distance, after the start frame', () => {
    expect(videoTimeAt(TABLE, TRACK.length / 2)).toBeCloseTo(50, 6);
    expect(videoTimeAt(TABLE, 0, 1)).toBeCloseTo(1, 6);
  });

  it('holds at the start and the end of the route', () => {
    expect(videoTimeAt(TABLE, -3)).toBe(0);
    expect(videoTimeAt(TABLE, TRACK.length + 50)).toBe(100);
  });

  it('keeps a constant speed up to both ends', () => {
    for (const time of [0.5, 2, 10, 90, 98, 99.5]) {
      expect(videoTimeAt(TABLE, (TRACK.length * time) / 100)).toBeCloseTo(time, 6);
    }
  });

  it('never decreases while the distance grows', () => {
    // Slow, fast, slow again, with a short standstill and a sudden spurt.
    const track = buildTrack(northbound([0, 10, 12, 20, 21, 22, 40, 41, 60], [0, 1, 6, 7, 7, 7, 9, 14, 15]));
    const table = buildVideoTime(track);
    let last = -1;
    for (let d = -5; d <= track.length + 5; d += 0.05) {
      const time = videoTimeAt(table, d);
      expect(time).toBeGreaterThanOrEqual(last);
      last = time;
    }
  });

  it('goes on where the camera moves again after it stood still', () => {
    // 1 step in 10 s, standing still from 10 s to 70 s, then 1 step in 10 s.
    const track = buildTrack(northbound([0, 10, 40, 70, 80], [0, 1, 1, 1, 2]));
    const table = buildVideoTime(track);
    const standstill = track.distances[1] ?? 0;
    // The smoothing reaches 4 σ before the camera moves again; up to there it stood still.
    expect(videoTimeAt(table, standstill)).toBeCloseTo(70 - 4 * SMOOTHING, 6);
    expect(videoTimeAt(table, standstill - 0.01)).toBeLessThan(10 + 4 * SMOOTHING);
  });

  it('stays close to the points of a track whose speed changes', () => {
    // 1 step in 10 s, then 1 in 2 s, then 1 in 10 s again: 1.1, 5.6 and 1.1 m/s.
    const times = [0, 10, 20, 30, 32, 34, 36, 38, 48, 58, 68];
    const track = buildTrack(northbound(times, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    const table = buildVideoTime(track);
    track.distances.forEach((distance, i) => {
      // Off by the time the camera needs for 4 m at the speed there: within a few seconds.
      expect(Math.abs(videoTimeAt(table, distance) - (times[i] ?? 0))).toBeLessThan(4);
    });
  });
});

describe('buildVideoTime', () => {
  it('samples the distance every 0.5 s of the track', () => {
    expect(TIME_STEP).toBe(0.5);
    expect(TABLE.distances).toHaveLength(201);
    expect(TABLE.distances[100]).toBeCloseTo(TRACK.length / 2, 6);
  });

  it('smooths a step in the camera speed', () => {
    // 10 steps in 100 s, then 10 steps in 50 s: the speed doubles at 100 s.
    const times = Array.from({ length: 21 }, (_, i) => (i <= 10 ? i * 10 : 100 + (i - 10) * 5));
    const track = buildTrack(northbound(times, times.map((_, i) => i)));
    const { distances } = buildVideoTime(track);
    const speeds = distances.slice(1).map((d, i) => d - (distances[i] ?? 0));
    const changes = speeds.slice(1).map((s, i) => Math.abs(s / (speeds[i] ?? 1) - 1));
    expect(Math.max(...changes)).toBeLessThan(0.07);
  });
});
