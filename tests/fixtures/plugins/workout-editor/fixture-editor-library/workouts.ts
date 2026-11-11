// SPDX-License-Identifier: AGPL-3.0-or-later

import type { LibraryWorkout, PlannedWorkout, Workout, WorkoutStep } from '@ridrs/contracts';

const power = (
  id: string,
  seconds: number,
  low: number,
  end?: number,
  intensity?: 'warm-up' | 'cool-down' | 'interval' | 'recovery',
  name?: string,
): WorkoutStep => ({
  kind: 'interval',
  id,
  ...(name ? { name } : {}),
  ...(intensity ? { intensity } : {}),
  duration: { kind: 'time', seconds },
  effort: {
    kind: 'target',
    primary: {
      unit: 'percent-ftp',
      start: { low, high: low },
      ...(end === undefined ? {} : { end: { low: end, high: end } }),
    },
  },
});

const workout = (
  id: string,
  name: string,
  source: Workout['source'],
  steps: WorkoutStep[],
  extra: Partial<Workout> = {},
): Workout => ({
  format: 'ridrs-workout',
  version: 1,
  id,
  name,
  sport: 'virtual-ride',
  source,
  steps,
  ...extra,
});

/** A built-in workout: read only, edited as a copy. */
export const BUILT_IN = workout(
  'sweet-spot-3x12',
  'Sweet Spot 3x12',
  { kind: 'builtin', format: 'zwo' },
  [
    power('1', 600, 50, 75, 'warm-up'),
    {
      kind: 'repeat',
      id: '2',
      until: { kind: 'count', reps: 3 },
      steps: [
        power('2.1', 720, 90, undefined, 'interval', 'Sweet spot'),
        power('2.2', 240, 55, undefined, 'recovery', 'Recovery'),
      ],
    },
    power('3', 300, 65, 45, 'cool-down'),
  ],
  { author: 'ridrs', license: 'CC-BY-SA-4.0' },
);

/** An own workout: warm-up, 3 × (4 min on, 2 min off), cool-down. */
export const OWN = workout('my-intervals', 'My Intervals', { kind: 'user' }, [
  power('w', 600, 50, 75, 'warm-up', 'Warm up'),
  {
    kind: 'repeat',
    id: 'r',
    until: { kind: 'count', reps: 3 },
    steps: [
      power('a', 240, 100, undefined, 'interval', 'On'),
      power('b', 120, 50, undefined, 'recovery', 'Off'),
    ],
  },
  power('c', 300, 65, 45, 'cool-down', 'Cool down'),
]);

/** An imported workout with steps by heart rate, distance and the lap button. */
export const IMPORTED = workout(
  'heart-rate-endurance',
  'Heart Rate Endurance',
  { kind: 'imported', format: 'fit', fileName: 'hr.fit' },
  [
    power('1', 600, 55, undefined, undefined, 'Easy spin'),
    {
      kind: 'interval',
      id: '2',
      name: 'Steady heart rate',
      duration: { kind: 'time', seconds: 1200 },
      effort: { kind: 'target', primary: { unit: 'bpm', start: { low: 130, high: 140 } } },
    },
    {
      kind: 'interval',
      id: '3',
      name: 'Five kilometres',
      duration: { kind: 'distance', meters: 5000 },
      effort: { kind: 'target', primary: { unit: 'percent-ftp', start: { low: 70, high: 70 } } },
    },
  ],
);

export const entryOf = (each: Workout): LibraryWorkout => ({
  id: each.id,
  name: each.name,
  sport: each.sport,
  steps: each.steps,
  workout: each,
});

export const LIBRARY: readonly Workout[] = [BUILT_IN, OWN, IMPORTED];

const planned = (id: string, date: string, workoutId: string): PlannedWorkout => ({
  id,
  date,
  name: 'x',
  sport: 'virtual-ride',
  steps: [],
  library: { from: 'ridrs', workoutId },
});

/** Three future days of "My Intervals", one past day, and one day of another workout. */
export const CALENDAR: readonly PlannedWorkout[] = [
  planned('p1', '2099-01-05', OWN.id),
  planned('p2', '2099-01-07', OWN.id),
  planned('p3', '2099-01-09', OWN.id),
  planned('p4', '2020-01-01', OWN.id),
  planned('p5', '2099-01-06', BUILT_IN.id),
];
