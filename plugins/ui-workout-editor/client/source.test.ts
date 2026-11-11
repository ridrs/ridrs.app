// SPDX-License-Identifier: AGPL-3.0-or-later

import type { LibraryWorkout, PlannedWorkout } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import { blankWorkout } from './model.ts';
import { type Library, plannedDays, startingWorkout } from './source.ts';

const entry: LibraryWorkout = {
  id: 'a',
  name: 'Alpha',
  sport: 'ride',
  steps: [],
  workout: {
    ...blankWorkout('a'),
    name: 'Alpha',
    author: 'ridrs',
    license: 'CC-BY-SA-4.0',
    source: { kind: 'builtin' },
  },
};
const libraries = new Map<string, Library>([
  ['ridrs', { provider: 'ridrs', label: 'ridrs', status: 'ready', writable: true, data: { workouts: [entry] } }],
]);

describe('the starting workout', () => {
  it('is blank for a new one', () => {
    expect(startingWorkout({ kind: 'new' }, new Map(), (n) => n, blankWorkout())).toMatchObject({ state: 'ready' });
  });

  it('is the entry for an edit', () => {
    const shown = startingWorkout({ kind: 'edit', from: 'ridrs', workoutId: 'a' }, libraries, (n) => n, blankWorkout());
    expect(shown).toMatchObject({ state: 'ready', workout: { id: 'a', source: { kind: 'builtin' } } });
  });

  it('is an own copy with author and licence for a copy', () => {
    const shown = startingWorkout({ kind: 'copy', from: 'ridrs', workoutId: 'a' }, libraries, (n) => `Copy of ${n}`, blankWorkout());
    expect(shown).toMatchObject({
      state: 'ready',
      workout: { name: 'Copy of Alpha', author: 'ridrs', license: 'CC-BY-SA-4.0', source: { kind: 'user' } },
    });
  });

  it('is loading or missing when the entry is not there', () => {
    const subject = { kind: 'edit', from: 'x', workoutId: 'a' } as const;
    expect(startingWorkout(subject, new Map(), (n) => n, blankWorkout())).toEqual({ state: 'loading' });
    expect(startingWorkout({ ...subject, from: 'ridrs', workoutId: 'zzz' }, libraries, (n) => n, blankWorkout())).toEqual({ state: 'missing' });
  });
});

describe('planned days', () => {
  const planned = (id: string, date: string, workoutId = 'a'): PlannedWorkout => ({
    id,
    date,
    name: 'x',
    sport: 'ride',
    steps: [],
    library: { from: 'ridrs', workoutId },
  });
  const calendars = new Map([
    [
      'ridrs',
      {
        provider: 'ridrs',
        label: 'r',
        status: 'ready' as const,
        writable: true,
        data: { workouts: [planned('1', '2099-01-01'), planned('2', '2099-01-01'), planned('3', '2099-01-02'), planned('4', '2020-01-01'), planned('5', '2099-01-03', 'b')] },
      },
    ],
  ]);

  it('counts the distinct days of this workout from today on', () => {
    expect(plannedDays(calendars, 'ridrs', 'a', '2026-11-11')).toBe(2);
    expect(plannedDays(calendars, 'ridrs', 'zzz', '2026-11-11')).toBe(0);
  });
});
