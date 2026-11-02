// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { DEMO_COURSE, gradientAt } from './course.ts';

describe('gradientAt on the demo course', () => {
  it.each([
    [0, 0],
    [1999.99, 0],
    [2000, 0.05],
    [2999.99, 0.05],
    [3000, 0],
    [3499.99, 0],
    [3500, -0.05],
    [4499.99, -0.05],
    [4500, 0],
    [100_000, 0],
  ])('at %f m is %f', (distance, gradient) => {
    expect(gradientAt(DEMO_COURSE, distance)).toBe(gradient);
  });

  it('lists its segments sorted by start', () => {
    const starts = DEMO_COURSE.map((segment) => segment.from);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });
});
