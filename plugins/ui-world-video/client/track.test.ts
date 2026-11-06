// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import type { TrackPoint } from './library.ts';
import { buildTrack, GRADIENT_BASE, gradientAt, haversine, MAX_GRADIENT, placeAt } from './track.ts';

/** 0.001° of latitude: about 111.2 m on the meridian. */
const STEP = 0.001;
const metres = haversine(
  { latitude: 0, longitude: 0, elevation: 0, time: 0 },
  { latitude: STEP, longitude: 0, elevation: 0, time: 0 },
);

const point = (i: number, elevation: number, time: number): TrackPoint => ({
  latitude: 45 + i * STEP,
  longitude: 5,
  elevation,
  time,
});

// Flat, then 5 % up, then the camera stands still for 10 s, then flat again.
const TRACK = buildTrack([
  point(0, 100, 0),
  point(1, 100, 10),
  point(2, 100 + 0.05 * metres, 30),
  point(2, 100 + 0.05 * metres, 40),
  point(3, 100 + 0.05 * metres, 50),
]);

describe('buildTrack', () => {
  it('measures the path along the points', () => {
    expect(metres).toBeCloseTo(111.2, 1);
    expect(TRACK.length).toBeCloseTo(3 * metres, 6);
    expect(TRACK.distances[2]).toBe(TRACK.distances[3]);
  });

  it('needs two points', () => {
    expect(() => buildTrack([point(0, 0, 0)])).toThrow();
  });
});

describe('placeAt', () => {
  it('interpolates position, elevation and video time between two points', () => {
    const place = placeAt(TRACK, 1.5 * metres);
    expect(place.latitude).toBeCloseTo(45 + 1.5 * STEP, 9);
    expect(place.elevation).toBeCloseTo(100 + 0.025 * metres, 6);
    expect(place.time).toBeCloseTo(20, 6);
  });

  it('goes on where the camera moves again after it stood still', () => {
    expect(placeAt(TRACK, TRACK.distances[2] ?? 0).time).toBe(40);
    expect(placeAt(TRACK, 2.5 * metres).time).toBeCloseTo(45, 6);
  });

  it('holds the first point before the start and the last beyond the end', () => {
    expect(placeAt(TRACK, -5).time).toBe(0);
    expect(placeAt(TRACK, 10 * metres)).toMatchObject({ latitude: 45 + 3 * STEP, time: 50 });
  });
});

describe('gradientAt', () => {
  it('is the rise over run across the base, centred on the distance', () => {
    expect(gradientAt(TRACK, 0.5 * metres)).toBe(0);
    expect(gradientAt(TRACK, 1.5 * metres)).toBeCloseTo(0.05, 9);
    expect(gradientAt(TRACK, metres)).toBeCloseTo(0.025, 9);
  });

  it('is flat beyond the end', () => {
    expect(gradientAt(TRACK, 3 * metres + GRADIENT_BASE)).toBe(0);
  });

  it(`keeps within ±${MAX_GRADIENT * 100} %`, () => {
    const wall = buildTrack([point(0, 0, 0), point(1, metres, 10)]);
    expect(gradientAt(wall, metres / 2)).toBe(MAX_GRADIENT);
  });
});
