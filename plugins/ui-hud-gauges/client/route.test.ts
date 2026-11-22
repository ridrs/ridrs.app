// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { fitPlaces, gradeColour, headingAt, indexAtDistance, measureTrack, profileOf, thin } from './route.ts';

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

describe('measureTrack and indexAtDistance', () => {
  it('finds the point of the track at or before the ridden distance', () => {
    const measured = measureTrack(NORTH_THEN_EAST);
    expect(measured[0]?.distance).toBe(0);
    expect(measured[1]?.distance).toBeCloseTo(445, 0);
    expect(indexAtDistance(measured, 0)).toBe(0);
    expect(indexAtDistance(measured, 450)).toBe(1);
    expect(indexAtDistance(measured, 5000)).toBe(2);
  });

  it('stays on the outbound leg of an out-and-back track instead of jumping to the return leg', () => {
    const outAndBack = measureTrack([
      { latitude: 46.0, longitude: 7.0 },
      { latitude: 46.002, longitude: 7.0 },
      { latitude: 46.004, longitude: 7.0 },
      { latitude: 46.002, longitude: 7.0 },
      { latitude: 46.0, longitude: 7.0 },
    ]);
    // Same geographic spot appears at ~222 m (outbound, index 1) and ~667 m (return, index 3).
    expect(indexAtDistance(outAndBack, 223)).toBe(1);
    expect(headingAt(outAndBack, 1)).toBeCloseTo(0, 0);
    expect(indexAtDistance(outAndBack, 668)).toBe(3);
    expect(headingAt(outAndBack, 3)).toBeCloseTo(180, 0);
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

  it('keeps facing the road ahead when looking ahead folds back onto the start at a U-turn', () => {
    // 25 m east, then 25 m straight back west to the same spot (~0.00032° lon at 46°).
    const uTurn = [
      { latitude: 46, longitude: 7 },
      { latitude: 46, longitude: 7.00032 },
      { latitude: 46, longitude: 7 },
    ];
    expect(headingAt(uTurn, 0, 50)).toBeCloseTo(90, 0);
  });

  it('keeps the arrival direction when the track ends with stationary points', () => {
    const stationaryEnd = [
      { latitude: 46, longitude: 7 },
      { latitude: 46, longitude: 7.01 },
      { latitude: 46, longitude: 7.01 },
    ];
    expect(headingAt(stationaryEnd, 2)).toBeCloseTo(90, 0);
  });
});
