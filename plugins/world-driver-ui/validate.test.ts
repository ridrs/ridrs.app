// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { validatePosition, validateTerrainWindow } from './validate.ts';

const valid = {
  revision: 2,
  originDistance: 10,
  spacing: 1,
  samples: [
    { gradient: 0.3, surface: 'asphalt' },
    { gradient: -0.3, surface: 'gravel' },
    { gradient: 0 },
  ],
};

const check = (window: unknown, state: { odometer: number; lastRevision?: number } = { odometer: 10, lastRevision: 1 }) =>
  validateTerrainWindow(window as typeof valid, state);

describe('validateTerrainWindow', () => {
  it('accepts a window at the odometer, gradients up to ±30 %, with or without a surface', () => {
    expect(check(valid)).toEqual({ valid: true, preview: valid });
  });

  it('accepts the first revision of a source', () => {
    expect(check({ ...valid, revision: 1 }, { odometer: 10 })).toMatchObject({ valid: true });
  });

  it.each([
    ['a non-finite origin', { ...valid, originDistance: Number.NaN }, 'invalid-origin'],
    ['an infinite origin', { ...valid, originDistance: Number.POSITIVE_INFINITY }, 'invalid-origin'],
    ['an origin behind 0 m', { ...valid, originDistance: -0.5 }, 'invalid-origin'],
    ['an origin ahead of the odometer', { ...valid, originDistance: 10.5 }, 'origin-ahead-of-rider'],
    ['no spacing', { ...valid, spacing: 0 }, 'invalid-spacing'],
    ['a non-finite spacing', { ...valid, spacing: Number.NaN }, 'invalid-spacing'],
    ['one sample', { ...valid, samples: [{ gradient: 0 }] }, 'too-few-samples'],
    [
      'a non-finite gradient',
      { ...valid, samples: [{ gradient: 0 }, { gradient: Number.NaN }] },
      'invalid-gradient',
    ],
    [
      'a gradient beyond 30 %',
      { ...valid, samples: [{ gradient: 0 }, { gradient: 0.300001 }] },
      'invalid-gradient',
    ],
    [
      'an unknown surface',
      { ...valid, samples: [{ gradient: 0 }, { gradient: 0, surface: 'ice' }] },
      'unknown-surface',
    ],
    ['the same revision', { ...valid, revision: 1 }, 'revision-not-ascending'],
    ['a non-integer revision', { ...valid, revision: 2.5 }, 'revision-not-ascending'],
  ])('rejects %s', (_, window, reason) => {
    expect(check(window)).toEqual({ valid: false, reason });
  });
});

describe('validatePosition', () => {
  const position = { distance: 10, latitude: 44.66, longitude: 5.42, altitude: 498.1 };
  const checkPosition = (observed: unknown, odometer = 10) =>
    validatePosition(observed as typeof position, { odometer });

  it('accepts a position at the odometer, with or without an altitude', () => {
    expect(checkPosition(position)).toEqual({ valid: true, position });
    const { altitude: _, ...flat } = position;
    expect(checkPosition(flat)).toEqual({ valid: true, position: flat });
  });

  it('accepts the poles and the date line', () => {
    expect(checkPosition({ ...position, latitude: -90, longitude: 180 })).toMatchObject({ valid: true });
  });

  it.each([
    ['a non-finite distance', { ...position, distance: Number.NaN }, 'invalid-distance'],
    ['a distance behind 0 m', { ...position, distance: -0.5 }, 'invalid-distance'],
    ['a distance ahead of the odometer', { ...position, distance: 10.5 }, 'distance-ahead-of-rider'],
    ['a latitude beyond 90°', { ...position, latitude: 90.5 }, 'invalid-latitude'],
    ['a non-finite latitude', { ...position, latitude: Number.NaN }, 'invalid-latitude'],
    ['a longitude beyond 180°', { ...position, longitude: -180.5 }, 'invalid-longitude'],
    ['an infinite altitude', { ...position, altitude: Number.POSITIVE_INFINITY }, 'invalid-altitude'],
  ])('rejects %s', (_, observed, reason) => {
    expect(checkPosition(observed)).toEqual({ valid: false, reason });
  });
});
