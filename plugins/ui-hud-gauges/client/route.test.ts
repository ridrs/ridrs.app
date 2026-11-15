// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { fitPlaces, gradeColour, headingAt, nearestIndex, profileOf, thin } from './route.ts';

const NORTH_THEN_EAST = [
  { latitude: 46.0, longitude: 7.0 },
  { latitude: 46.004, longitude: 7.0 },
  { latitude: 46.008, longitude: 7.003 },
];

describe('fitPlaces', () => {
  it('fits the places into the drawing, north up, with the pad around them', () => {
    const project = fitPlaces(NORTH_THEN_EAST, 200, 100, 10);
    const [start, , end] = NORTH_THEN_EAST.map(project);
    expect(start?.y).toBeCloseTo(90, 0);
    expect(end?.y).toBeCloseTo(10, 0);
    expect(end?.x ?? 0).toBeGreaterThan(start?.x ?? 0);
  });
});

describe('nearestIndex', () => {
  it('finds the point of the track nearest to the rider', () => {
    expect(nearestIndex(NORTH_THEN_EAST, { latitude: 46.0041, longitude: 7.0001 })).toBe(1);
  });
});

describe('thin', () => {
  it('keeps the first and the last and at most the number asked for', () => {
    const items = Array.from({ length: 1001 }, (_, i) => i);
    const kept = thin(items, 400);
    expect(kept).toHaveLength(400);
    expect(kept[0]).toBe(0);
    expect(kept.at(-1)).toBe(1000);
    expect(thin([1, 2, 3], 400)).toEqual([1, 2, 3]);
  });
});

describe('profileOf', () => {
  it('colours each stretch by its gradient', () => {
    // 1 km between samples: 10 m up is 1 %, 70 m up is 7 %.
    const { stretches, line } = profileOf([100, 110, 180], 2000, 200, 50);
    expect(stretches.map((s) => s.colour)).toEqual([gradeColour(1), gradeColour(7)]);
    expect(stretches.map((s) => [s.from, s.to])).toEqual([
      [0, 0.5],
      [0.5, 1],
    ]);
    expect(line).toHaveLength(3);
  });

  it('has nothing to draw without two elevations', () => {
    expect(profileOf([100], 1000, 200, 50).stretches).toEqual([]);
  });
});

describe('headingAt', () => {
  it('points along the track, clockwise from north', () => {
    expect(headingAt(NORTH_THEN_EAST, 0, 100)).toBeCloseTo(0, 0);
    const east = [
      { latitude: 46, longitude: 7 },
      { latitude: 46, longitude: 7.01 },
    ];
    expect(headingAt(east, 0)).toBeCloseTo(90, 0);
  });

  it('faces along the road up to a hairpin, not across to the road after it', () => {
    // 100 m east, a hairpin, then back west 20 m further north: about 0.0009° of longitude per
    // 70 m at 46°, 0.00018° of latitude per 20 m.
    const hairpin = [
      { latitude: 46, longitude: 7 },
      { latitude: 46, longitude: 7.0006 },
      { latitude: 46, longitude: 7.0013 },
      { latitude: 46.00018, longitude: 7.0013 },
      { latitude: 46.00018, longitude: 7.0006 },
      { latitude: 46.00018, longitude: 7 },
    ];
    expect(headingAt(hairpin, 0)).toBeCloseTo(90, 0);
  });

  it('keeps the last direction at the end of the track', () => {
    const east = [
      { latitude: 46, longitude: 7 },
      { latitude: 46, longitude: 7.01 },
    ];
    expect(headingAt(east, 1)).toBeCloseTo(90, 0);
  });
});
