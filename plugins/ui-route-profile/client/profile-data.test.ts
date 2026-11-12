// SPDX-License-Identifier: AGPL-3.0-or-later

import type { RouteOffer } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import { gradeOf, stretchesOf } from './profile-data.ts';

const offer = (id: string, distance: number, ascent: number): RouteOffer => ({
  id: `test/${id}`,
  kind: 'world',
  title: id,
  distance,
  ascent,
  tags: {},
  availability: { state: 'ready' },
  world: { landscape: 'test/landscape' },
});

describe('the profile', () => {
  const hill = { ...offer('hill', 3_000, 150), sparkline: [500, 500, 560, 650] };

  it('cuts the elevations into stretches with their gradients', () => {
    expect(stretchesOf(hill).map((stretch) => [stretch.from, stretch.to, stretch.grade])).toEqual([
      [0, 1000, 0],
      [1000, 2000, 6],
      [2000, 3000, 9],
    ]);
    expect(stretchesOf(offer('none', 1000, 0))).toEqual([]);
  });

  it('runs through each summit, at its altitude, between the elevations', () => {
    const pass: RouteOffer = {
      ...offer('pass', 4_000, 160),
      sparkline: [500, 500, 560, 650, 600],
      climbs: [{ category: '4', start: 1000, end: 2800, gain: 160, grade: 8.9, summit: 660 }],
    };
    expect(stretchesOf(pass).map((stretch) => [stretch.from, stretch.to, stretch.high, stretch.grade])).toEqual([
      [0, 1000, 500, 0],
      [1000, 2000, 560, 6],
      [2000, 2800, 660, 12.5],
      [2800, 3000, 650, -5],
      [3000, 4000, 600, -5],
    ]);
  });

  it('colours a stretch by the gradient over 500 m around it, so GPS jitter does not stripe it', () => {
    // A steady 3 % with one sample 4 m too high in the middle.
    const sparkline = Array.from({ length: 21 }, (_, i) => 500 + i * 3 + (i === 10 ? 4 : 0));
    const ramp = { ...offer('ramp', 2_000, 60), sparkline };
    const [before, after] = stretchesOf(ramp).slice(9, 11);
    expect([before?.grade, after?.grade].map((grade) => grade?.toFixed(1))).toEqual(['7.0', '-1.0']);
    expect([before?.trend, after?.trend].map((trend) => trend?.toFixed(1))).toEqual(['3.0', '3.0']);
  });

  it('bands a gradient like the profile picture, a descent as flat', () => {
    expect(gradeOf(-7).label).toBe('below 2 %');
    expect(gradeOf(4).label).toBe('4–6 %');
    expect(gradeOf(12).label).toBe('10 % and more');
  });
});
