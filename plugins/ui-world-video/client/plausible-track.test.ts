// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import type { TrackPoint } from './library.ts';
import { PLAUSIBLE, plausibleTrack } from './plausible-track.ts';
import { buildTrack } from './track.ts';

/** m per degree of latitude, as the haversine distance has it. */
const METRES_PER_DEGREE = (6_371_008.8 * Math.PI) / 180;

/** A point `north` m north and `east` m east of 45° N, 5° E, at `time` s. */
const at = (north: number, time: number, east = 0): TrackPoint => ({
  latitude: 45 + north / METRES_PER_DEGREE,
  longitude: 5 + east / (METRES_PER_DEGREE * Math.SQRT1_2),
  elevation: 100,
  time,
});

/** Due north at 5 m/s with a point every second. */
const straight = (seconds: number) => Array.from({ length: seconds + 1 }, (_, t) => at(5 * t, t));

describe('plausibleTrack', () => {
  it('leaves a plausible track as buildTrack builds it', () => {
    const points = straight(60);
    const { track, repairs } = plausibleTrack(points);
    expect(repairs).toEqual([]);
    expect(track.points).toEqual(points);
    expect(track.distances).toEqual(buildTrack(points).distances);
  });

  it('keeps a camera that stands still', () => {
    const points = [...straight(20), ...Array.from({ length: 10 }, (_, i) => at(100, 21 + i)), at(105, 31)];
    expect(plausibleTrack(points).repairs).toEqual([]);
  });

  it('drops a point whose time does not increase', () => {
    const points = straight(20);
    points.splice(10, 0, at(48, 9));
    const { track, repairs } = plausibleTrack(points);
    expect(repairs).toEqual([{ kind: 'time', time: 9 }]);
    expect(track.points).toHaveLength(21);
  });

  it('never drops the first or the last point', () => {
    const points = straight(20);
    points[0] = at(0, 0, 30);
    points[20] = at(100, 20, 30);
    const { track } = plausibleTrack(points);
    expect(track.points[0]).toBe(points[0]);
    expect(track.points.at(-1)).toBe(points[20]);
  });

  it('builds a track of two points', () => {
    const { track, repairs } = plausibleTrack([at(0, 0), at(500, 10)]);
    expect(repairs).toEqual([]);
    expect(track.length).toBeCloseTo(500, 6);
  });

  it('allows more from a sparse track: a point may lie further off between distant neighbours', () => {
    // 20 m sideways is a spike between neighbours 1 s away, a curve between neighbours 10 s away.
    const dense = straight(20);
    dense[10] = at(50, 10, 20);
    expect(plausibleTrack(dense).repairs).toEqual([{ kind: 'spike', time: 10 }]);
    const sparse = [at(0, 0), at(50, 10), at(100, 20, 20), at(150, 30), at(200, 40)];
    expect(plausibleTrack(sparse).repairs).toEqual([]);
  });

  it('measures a jump along the path, so the positions stay where the GPS put them', () => {
    const points = straight(30).map((p, t) => (t >= 15 ? at(5 * t + 40, t) : p));
    const { track, repairs } = plausibleTrack(points);
    expect(repairs).toEqual([{ kind: 'jump', time: 15, metres: expect.closeTo(40, 6) }]);
    expect(track.points).toEqual(points);
    expect(track.length).toBeCloseTo(150, 6);
  });

  it('holds to the limits of a bicycle or a camera motorbike', () => {
    expect(PLAUSIBLE).toEqual({ longitudinal: 4, lateral: 5, position: 1.5, speed: 1.5 });
  });
});
