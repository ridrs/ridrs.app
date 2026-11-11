// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  AthleteProfile,
  DataSource,
  LibraryWorkout,
  PlannedWorkout,
  TrainingCalendar,
  Workout,
} from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import { chosenAthlete, editRef, type Library, shownWorkout } from './subject.ts';

const steps: Workout['steps'] = [
  {
    kind: 'interval',
    id: '1',
    duration: { kind: 'time', seconds: 600 },
    effort: { kind: 'target', primary: { unit: 'percent-ftp', start: { low: 60, high: 60 } } },
  },
];

const canonical: Workout = {
  format: 'ridrs-workout',
  version: 1,
  id: 'easy',
  name: 'Easy',
  description: 'Spin easy.',
  sport: 'ride',
  author: 'ridrs',
  license: 'CC-BY-SA-4.0',
  source: { kind: 'builtin' },
  steps,
};

const source = <D,>(provider: string, data?: D, status: DataSource<D>['status'] = 'ready'): DataSource<D> => ({
  provider,
  label: provider,
  status,
  writable: false,
  ...(data ? { data } : {}),
});

const library = (workouts: LibraryWorkout[], status?: DataSource<unknown>['status']): Library =>
  source('lib', { workouts }, status);

const planned: PlannedWorkout = {
  id: 'p1',
  date: '2026-11-12',
  name: 'Easy',
  sport: 'ride',
  steps,
  library: { from: 'lib', workoutId: 'easy' },
};

describe('shownWorkout', () => {
  it('shows the canonical workout of a library entry that has one', () => {
    const libraries = new Map([['lib', library([{ id: 'easy', name: 'Easy', sport: 'ride', steps, workout: canonical }])]]);
    expect(shownWorkout({ kind: 'library', from: 'lib', workoutId: 'easy' }, libraries, new Map())).toEqual({
      state: 'shown',
      workout: canonical,
    });
  });

  it('builds a workout from the steps of an entry without one, converting nothing', () => {
    const libraries = new Map([['lib', library([{ id: 'x', name: 'X', sport: 'virtual-ride', steps }])]]);
    const shown = shownWorkout({ kind: 'library', from: 'lib', workoutId: 'x' }, libraries, new Map());
    expect(shown).toEqual({
      state: 'shown',
      workout: {
        format: 'ridrs-workout',
        version: 1,
        id: 'x',
        name: 'X',
        sport: 'virtual-ride',
        source: { kind: 'provider' },
        steps,
      },
    });
  });

  it('is loading while the provider has no data yet, and missing once it has and lacks the entry', () => {
    const subject = { kind: 'library', from: 'lib', workoutId: 'easy' } as const;
    expect(shownWorkout(subject, new Map(), new Map())).toEqual({ state: 'loading' });
    expect(shownWorkout(subject, new Map([['lib', source<{ workouts: LibraryWorkout[] }>('lib', undefined, 'loading')]]), new Map())).toEqual({
      state: 'loading',
    });
    expect(shownWorkout(subject, new Map([['lib', library([])]]), new Map())).toEqual({ state: 'missing' });
  });

  it('shows a planned entry with its date, and author and licence of the library workout it came from', () => {
    const libraries = new Map([['lib', library([{ id: 'easy', name: 'Easy', sport: 'ride', steps, workout: canonical }])]]);
    const calendars = new Map([['cal', source<TrainingCalendar>('cal', { workouts: [planned] })]]);
    const shown = shownWorkout({ kind: 'planned', from: 'cal', id: 'p1' }, libraries, calendars);
    expect(shown).toMatchObject({
      state: 'shown',
      plannedFor: '2026-11-12',
      workout: { name: 'Easy', author: 'ridrs', license: 'CC-BY-SA-4.0', description: 'Spin easy.', steps },
    });
  });

  it('shows a planned entry without a library workout as it is', () => {
    const { library: _, ...own } = planned;
    const calendars = new Map([['cal', source<TrainingCalendar>('cal', { workouts: [own] })]]);
    const shown = shownWorkout({ kind: 'planned', from: 'cal', id: 'p1' }, new Map(), calendars);
    expect(shown.state).toBe('shown');
    expect(shown.state === 'shown' ? shown.workout.author : 'none').toBeUndefined();
  });
});

describe('chosenAthlete', () => {
  const profiles = new Map<string, DataSource<AthleteProfile>>([
    ['ridrs', source('ridrs', { ftp: 250, weight: 72 })],
    ['intervals.icu', source('intervals.icu', { ftp: 280, lthr: 170, name: 'Alex' })],
  ]);

  it('reads the profile of ridrs without a choice', () => {
    expect(chosenAthlete(profiles, new Map())).toEqual({ ftp: 250 });
  });

  it('reads the chosen source, only what the details use', () => {
    expect(chosenAthlete(profiles, new Map([['athlete.profile', { provider: 'intervals.icu' }]]))).toEqual({
      ftp: 280,
      lthr: 170,
    });
  });
});

describe('editRef', () => {
  const entry = (id: string, kind: 'builtin' | 'user'): LibraryWorkout => ({
    id,
    name: id,
    sport: 'ride',
    steps,
    workout: { ...canonical, id, source: { kind } },
  });
  const libraries = new Map<string, Library>([
    ['ridrs', { provider: 'ridrs', label: 'r', status: 'ready', writable: true, data: { workouts: [entry('mine', 'user'), entry('built', 'builtin')] } }],
    ['other', { provider: 'other', label: 'o', status: 'ready', writable: false, data: { workouts: [entry('mine', 'user')] } }],
  ]);
  const calendars = new Map<string, DataSource<TrainingCalendar>>([
    [
      'ridrs',
      {
        provider: 'ridrs',
        label: 'r',
        status: 'ready',
        writable: true,
        data: {
          workouts: [
            { id: 'p1', date: '2099-01-01', name: 'x', sport: 'ride', steps, library: { from: 'ridrs', workoutId: 'mine' } },
            { id: 'p2', date: '2099-01-02', name: 'y', sport: 'ride', steps },
          ],
        },
      },
    ],
  ]);

  it('edits an own workout of the ridrs library and copies every other one', () => {
    expect(editRef({ kind: 'library', from: 'ridrs', workoutId: 'mine' }, libraries, calendars)).toMatchObject({ own: true });
    expect(editRef({ kind: 'library', from: 'ridrs', workoutId: 'built' }, libraries, calendars)).toMatchObject({ own: false });
    expect(editRef({ kind: 'library', from: 'other', workoutId: 'mine' }, libraries, calendars)).toMatchObject({ own: false });
  });

  it('follows a planned entry to the library workout it came from, if it has one', () => {
    expect(editRef({ kind: 'planned', from: 'ridrs', id: 'p1' }, libraries, calendars)).toEqual({ from: 'ridrs', workoutId: 'mine', own: true });
    expect(editRef({ kind: 'planned', from: 'ridrs', id: 'p2' }, libraries, calendars)).toBeUndefined();
  });
});
