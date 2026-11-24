// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AthleteProfile, DataSource, RideWorkout, Workout } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import {
  availableWorkouts,
  type Calendar,
  type Library,
  offerOf,
  resolveAthlete,
  resolveWorkoutForRide,
  sameRideWorkout,
  sameWorld,
} from './menu-choice.ts';

const workout = (id: string, name: string, percent: number): Workout => ({
  format: 'ridrs-workout',
  version: 1,
  id,
  name,
  sport: 'virtual-ride',
  source: { kind: 'provider' },
  steps: [
    {
      kind: 'interval',
      id: '1',
      intensity: 'interval',
      duration: { kind: 'time', seconds: 300 },
      effort: {
        kind: 'target',
        primary: { unit: 'percent-ftp', start: { low: percent, high: percent } },
      },
    },
  ],
});

describe('menu-choice', () => {
  it('resolves % FTP targets using the ride frozen FTP over the profile FTP', () => {
    const profiles = new Map<string, DataSource<AthleteProfile>>([
      ['ridrs', { provider: 'ridrs', label: 'ridrs', status: 'ready', writable: true, data: { ftp: 200 } }],
    ]);
    const athlete = resolveAthlete(profiles, new Map(), 250);
    const resolved = resolveWorkoutForRide({ workout: workout('w1', 'Sweet Spot', 90) }, athlete);
    expect(resolved.ok).toBe(true);
    expect(resolved.ok && JSON.stringify(resolved.ride.workout.steps)).toContain(
      '"unit":"watts","start":{"low":225,"high":225}',
    );
  });

  it('refuses a % FTP workout when neither the ride nor the profile has an FTP', () => {
    expect(resolveWorkoutForRide({ workout: workout('w1', 'Sweet Spot', 90) }, {})).toEqual({
      ok: false,
      refusal: 'no-ftp',
    });
  });

  it('lists planned workouts from today onwards and library workouts sorted by name', () => {
    const libraries = new Map<string, Library>([
      [
        'ridrs',
        {
          provider: 'ridrs',
          label: 'ridrs',
          status: 'ready',
          writable: true,
          data: {
            workouts: [
              { id: 'b', name: 'Zeta', sport: 'virtual-ride', steps: workout('b', 'Zeta', 80).steps },
              { id: 'a', name: 'Alpha', sport: 'virtual-ride', steps: workout('a', 'Alpha', 70).steps },
            ],
          },
        },
      ],
    ]);
    const calendars = new Map<string, Calendar>([
      [
        'intervals.icu',
        {
          provider: 'intervals.icu',
          label: 'intervals.icu',
          status: 'ready',
          writable: true,
          data: {
            workouts: [
              { id: 'past', date: '2026-11-03', name: 'Yesterday', sport: 'virtual-ride', steps: workout('p', 'Yesterday', 60).steps },
              { id: 'today', date: '2026-11-04', name: 'Today Plan', sport: 'virtual-ride', steps: workout('t', 'Today Plan', 85).steps },
            ],
          },
        },
      ],
    ]);
    const found = availableWorkouts(libraries, calendars, '2026-11-04');
    expect(found.planned.map((item) => item.name)).toEqual(['Today Plan']);
    expect(found.library.map((item) => item.name)).toEqual(['Alpha', 'Zeta']);
  });

  it('matches workouts and worlds accurately', () => {
    const plannedA: RideWorkout = { workout: workout('1', 'Plan', 80), planned: { provider: 'p', id: 'e1' } };
    const plannedB: RideWorkout = { workout: workout('1', 'Plan', 80), planned: { provider: 'p', id: 'e2' } };
    expect(sameRideWorkout(plannedA, plannedA)).toBe(true);
    expect(sameRideWorkout(plannedA, plannedB)).toBe(false);
    expect(sameWorld({ landscape: 'a/b', route: 'r1' }, { landscape: 'a/b', route: 'r1' })).toBe(true);
    expect(sameWorld({ landscape: 'a/b', route: 'r1' }, { landscape: 'a/b', route: 'r2' })).toBe(false);
    expect(
      offerOf({ landscape: 'a/b', route: 'r1' }, [
        {
          id: 'o1',
          kind: 'world',
          title: 'Loop',
          distance: 10_000,
          ascent: 100,
          tags: {},
          availability: { state: 'ready' },
          world: { landscape: 'a/b', route: 'r1' },
        },
      ])?.title,
    ).toBe('Loop');
  });
});
