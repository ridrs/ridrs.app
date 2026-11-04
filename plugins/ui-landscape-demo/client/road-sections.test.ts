// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { DEMO_LANDSCAPE, type LandscapeModel } from './landscape-model.ts';
import { roadSections } from './road-sections.ts';

const SHORT: LandscapeModel = {
  course: [{ from: 0, gradient: 0 }],
  surface: { period: 40, gravelFrom: 20 },
};

const spans = (model: LandscapeModel, position: number) =>
  roadSections(model, position).map(({ surface, from, to }) => [surface, from, to]);

describe('roadSections', () => {
  it('draws the demo landscape as asphalt at the start, as far as the horizon', () => {
    expect(spans(DEMO_LANDSCAPE, 0)).toEqual([['asphalt', 4, 160]]);
  });

  it('splits the road where the surface changes, nearest first', () => {
    expect(spans(DEMO_LANDSCAPE, 400)).toEqual([
      ['asphalt', 404, 500],
      ['gravel', 500, 560],
    ]);
    expect(spans(SHORT, 0)).toEqual([
      ['asphalt', 4, 20],
      ['gravel', 20, 40],
      ['asphalt', 40, 60],
      ['gravel', 60, 80],
      ['asphalt', 80, 100],
      ['gravel', 100, 120],
      ['asphalt', 120, 140],
      ['gravel', 140, 160],
    ]);
  });

  it('shows gravel under the rider on gravel', () => {
    expect(spans(DEMO_LANDSCAPE, 600)[0]).toEqual(['gravel', 604, 760]);
  });

  it('projects each section onto the road: nearer sections lower in the view', () => {
    const [near, far] = roadSections(SHORT, 0);
    expect(near?.quad).toHaveLength(4);
    const lowest = (quad: readonly (readonly [number, number])[]) => Math.max(...quad.map(([, y]) => y));
    expect(lowest(near?.quad ?? [])).toBeCloseTo(100, 12);
    expect(lowest(far?.quad ?? [])).toBeLessThan(lowest(near?.quad ?? []));
  });
});
