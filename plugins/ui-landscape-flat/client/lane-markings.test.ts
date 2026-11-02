// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { LANE_MARKINGS, laneDashes } from './lane-markings.ts';

const bottomOf = (points: readonly (readonly [number, number])[]) =>
  Math.max(...points.map(([, y]) => y));

describe('laneDashes', () => {
  it('draws dashes between the horizon and the bottom edge', () => {
    for (const dash of laneDashes(0)) {
      for (const [x, y] of dash) {
        expect(y).toBeGreaterThanOrEqual(LANE_MARKINGS.horizonY);
        expect(y).toBeLessThanOrEqual(100);
        expect(Math.abs(x - 50)).toBeLessThanOrEqual(LANE_MARKINGS.halfWidthAtBottom);
      }
    }
  });

  it('moves the dashes towards the rider as the road position grows', () => {
    const before = laneDashes(0);
    const after = laneDashes(1);
    expect(bottomOf(after[1] ?? [])).toBeGreaterThan(bottomOf(before[1] ?? []));
  });

  it('repeats after one dash period', () => {
    const period = LANE_MARKINGS.dashLength + LANE_MARKINGS.gapLength;
    const once = laneDashes(3);
    const later = laneDashes(3 + 10 * period);
    expect(later.length).toBe(once.length);
    later.forEach((dash, i) =>
      dash.forEach(([x, y], j) => {
        expect(x).toBeCloseTo(once[i]?.[j]?.[0] ?? Number.NaN, 9);
        expect(y).toBeCloseTo(once[i]?.[j]?.[1] ?? Number.NaN, 9);
      }),
    );
  });

  it('gets narrower and shorter towards the horizon', () => {
    const dashes = laneDashes(0);
    const height = (dash: (typeof dashes)[number]) =>
      bottomOf(dash) - Math.min(...dash.map(([, y]) => y));
    expect(height(dashes[1] ?? [])).toBeGreaterThan(height(dashes[4] ?? []));
  });
});
