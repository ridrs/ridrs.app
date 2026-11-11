// SPDX-License-Identifier: AGPL-3.0-or-later

import type { LibraryWorkout } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import { durationClassesIn, durationClassOf, focusesIn, passes } from './catalogue.ts';

const workout = (id: string, minutes?: number, focus?: string): LibraryWorkout =>
  ({
    id,
    name: id,
    sport: 'ride',
    steps: [],
    ...(minutes === undefined ? {} : { durationSeconds: minutes * 60 }),
    ...(focus === undefined
      ? {}
      : { workout: { format: 'ridrs-workout', version: 1, id, name: id, sport: 'ride', focus, source: { kind: 'builtin' }, steps: [] } }),
  }) as LibraryWorkout;

describe('the catalogue filter', () => {
  it('classes a length by its minutes', () => {
    expect([20, 30, 31, 60, 75, 90, 91, 240].map((m) => durationClassOf(m * 60))).toEqual([
      'short',
      'short',
      'medium',
      'medium',
      'long',
      'long',
      'extra-long',
      'extra-long',
    ]);
    expect(durationClassOf(undefined)).toBeUndefined();
  });

  it('lets everything through while nothing is chosen', () => {
    expect(passes({ provider: 'ridrs', workout: workout('a') }, {})).toBe(true);
  });

  it('narrows by provider, focus and duration together', () => {
    const item = { provider: 'ridrs', workout: workout('a', 45, 'tempo') };
    expect(passes(item, { provider: 'ridrs', focus: 'tempo', duration: 'medium' })).toBe(true);
    expect(passes(item, { provider: 'intervals.icu' })).toBe(false);
    expect(passes(item, { focus: 'vo2max' })).toBe(false);
    expect(passes(item, { duration: 'long' })).toBe(false);
  });

  it('keeps a workout of unknown focus or length out of a filter on it', () => {
    const item = { provider: 'intervals.icu', workout: workout('b') };
    expect(passes(item, { focus: 'tempo' })).toBe(false);
    expect(passes(item, { duration: 'short' })).toBe(false);
  });

  it('offers only the choices the catalogue has', () => {
    const items = [
      { provider: 'ridrs', workout: workout('a', 45, 'tempo') },
      { provider: 'ridrs', workout: workout('b', 120, 'endurance') },
    ];
    expect(focusesIn(items, ['recovery', 'endurance', 'tempo'])).toEqual(['endurance', 'tempo']);
    expect(durationClassesIn(items)).toEqual(['medium', 'extra-long']);
  });
});
