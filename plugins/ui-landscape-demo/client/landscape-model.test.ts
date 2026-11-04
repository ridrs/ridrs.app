// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import {
  DEMO_COURSE,
  DEMO_LANDSCAPE,
  DEMO_SURFACE,
  gradientAt,
  remainingAhead,
  surfaceAt,
  terrainWindow,
} from './landscape-model.ts';

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

describe('surfaceAt on the demo landscape', () => {
  it.each([
    [0, 'asphalt'],
    [2999.99, 'asphalt'],
    [3000, 'gravel'],
    [3999.99, 'gravel'],
    [4000, 'asphalt'],
    [6999.99, 'asphalt'],
    [7000, 'gravel'],
    [8000, 'asphalt'],
    [43_500, 'gravel'],
  ] as const)('at %f m is %s', (distance, surface) => {
    expect(surfaceAt(DEMO_SURFACE, distance)).toBe(surface);
  });
});

describe('terrainWindow on the demo landscape', () => {
  it('samples 20 m ahead every metre from the whole metre at or before the odometer', () => {
    const window = terrainWindow(DEMO_LANDSCAPE, 1990.4);
    expect(window.originDistance).toBe(1990);
    expect(window.spacing).toBe(1);
    expect(window.samples).toHaveLength(21);
    expect(window.samples.map((s) => s.gradient)).toEqual([
      ...Array(10).fill(0),
      ...Array(11).fill(0.05),
    ]);
  });

  it('carries the surface of every sample', () => {
    const window = terrainWindow(DEMO_LANDSCAPE, 2990);
    expect(window.samples.map((s) => s.surface)).toEqual([
      ...Array(10).fill('asphalt'),
      ...Array(11).fill('gravel'),
    ]);
  });

  it('puts samples on the same grid whatever the odometer reading', () => {
    expect(terrainWindow(DEMO_LANDSCAPE, 1999.99).originDistance).toBe(1999);
    expect(terrainWindow(DEMO_LANDSCAPE, 2000).originDistance).toBe(2000);
  });

  it('measures what is left of a window ahead of the odometer', () => {
    const window = terrainWindow(DEMO_LANDSCAPE, 0);
    expect(remainingAhead(window, 0)).toBe(20);
    expect(remainingAhead(window, 10.5)).toBe(9.5);
    expect(remainingAhead(window, 21)).toBe(-1);
  });
});
