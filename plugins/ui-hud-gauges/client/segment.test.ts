// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import {
  activeClimbOf,
  elevationAt,
  elevationPointsOf,
  isFlatTerrain,
  localProfileOf,
  perimeterRing,
  WORKOUT_RING_SEGMENTS,
} from './segment.ts';

describe('elevationPointsOf and elevationAt', () => {
  it('interpolates elevation linearly between track points and clamps outside', () => {
    const points = [
      { distance: 0, elevation: 100 },
      { distance: 100, elevation: 110 },
      { distance: 300, elevation: 150 },
    ];
    expect(elevationAt(points, -10)).toBe(100);
    expect(elevationAt(points, 50)).toBe(105);
    expect(elevationAt(points, 200)).toBe(130);
    expect(elevationAt(points, 500)).toBe(150);
  });

  it('integrates terrain-preview gradients when no track or sparkline exists', () => {
    const points = elevationPointsOf(undefined, undefined, {
      revision: 1,
      originDistance: 100,
      spacing: 50,
      samples: [{ gradient: 0.04 }, { gradient: 0.04 }, { gradient: 0.08 }],
    });
    expect(points).toEqual([
      { distance: 100, elevation: 0 },
      { distance: 150, elevation: 2 },
      { distance: 200, elevation: 5 },
    ]);
  });
});

describe('localProfileOf and isFlatTerrain', () => {
  it('strips everything beyond windowEnd (e.g. post-summit descent)', () => {
    const points = [
      { distance: 0, elevation: 100 },
      { distance: 500, elevation: 150 },
      { distance: 1000, elevation: 200 },
      { distance: 1500, elevation: 120 },
    ];
    const profile = localProfileOf(points, 930, 830, 1000, 266, 38);
    expect(profile).toBeDefined();
    // Every point of the climb-only profile ascends monotonically (y decreases as x increases).
    const ys = profile?.line.map((point) => point.y) ?? [];
    for (let i = 1; i < ys.length; i += 1) {
      expect(ys[i]).toBeLessThanOrEqual(ys[i - 1] ?? Number.POSITIVE_INFINITY);
    }
    expect(profile?.line.at(-1)?.x).toBeCloseTo(266, 1);
  });

  it('marks a flat window with flat live gradient as flat, and hilly terrain as non-flat', () => {
    const flat = localProfileOf(
      [
        { distance: 0, elevation: 100 },
        { distance: 600, elevation: 100.5 },
      ],
      100,
      0,
      600,
      266,
      38,
    );
    expect(isFlatTerrain(flat, 0)).toBe(true);
    expect(isFlatTerrain(flat, 2.5)).toBe(false);

    const hilly = localProfileOf(
      [
        { distance: 0, elevation: 100 },
        { distance: 600, elevation: 130 },
      ],
      100,
      0,
      600,
      266,
      38,
    );
    expect(isFlatTerrain(hilly, 0)).toBe(false);
  });
});

describe('activeClimbOf', () => {
  const climbs = [
    {
      category: '2' as const,
      start: 200,
      end: 1000,
      gain: 80,
      grade: 10,
      summit: 180,
      name: 'Route des Crêtes',
    },
  ];
  const points = [
    { distance: 200, elevation: 100 },
    { distance: 1000, elevation: 180 },
  ];

  it('starts a countdown at 10 s before the summit and reports climbed / total gain', () => {
    const early = activeClimbOf(climbs, 600, 10, points, 140);
    expect(early?.countdownSeconds).toBeUndefined();
    expect(early?.climbedGain).toBe(40);
    expect(early?.totalGain).toBe(80);

    const near = activeClimbOf(climbs, 930, 10, points, 173);
    expect(near?.countdownSeconds).toBe(7);
    expect(near?.climbedGain).toBe(73);
    expect(near?.totalGain).toBe(80);
  });
});

describe('perimeterRing', () => {
  it('splits the rounded-rect perimeter into fine uniform segments and fills proportionally', () => {
    const ring = perimeterRing(326, 126, 18, 3, WORKOUT_RING_SEGMENTS, 0.25);
    expect(ring.segments).toBe(36);
    expect(ring.filled).toBe(9);
    expect(ring.segmentLength).toBeGreaterThan(2);
    expect(ring.perimeter).toBeGreaterThan(800);
  });
});
