// SPDX-License-Identifier: AGPL-3.0-or-later

import type { LibraryWorkout, Workout, WorkoutStep } from '@ridrs/contracts';

/** The workouts of the export scenarios, written by hand for them. */
const workout = (
  id: string,
  name: string,
  steps: WorkoutStep[],
  extra: Partial<Workout> = {},
): Workout => ({
  format: 'ridrs-workout',
  version: 1,
  id,
  name,
  sport: 'ride',
  author: 'ridrs',
  license: 'CC-BY-SA-4.0',
  source: { kind: 'builtin' },
  steps,
  ...extra,
});

const time = (seconds: number) => ({ kind: 'time', seconds }) as const;
const percent = (value: number) =>
  ({
    kind: 'target',
    primary: { unit: 'percent-ftp', start: { low: value, high: value } },
  }) as const;
const watts = (value: number) =>
  ({ kind: 'target', primary: { unit: 'watts', start: { low: value, high: value } } }) as const;

/** Only % FTP: every format but ERG and TCX holds it as it is. */
export const SWEET_SPOT = workout('sweet-spot-3x12', 'Sweet Spot 3x12', [
  { kind: 'interval', id: '1', duration: time(600), effort: percent(60) },
  {
    kind: 'repeat',
    id: '2',
    until: { kind: 'count', reps: 3 },
    steps: [
      { kind: 'interval', id: '2.1', duration: time(720), effort: percent(90) },
      { kind: 'interval', id: '2.2', duration: time(240), effort: percent(55) },
    ],
  },
]);

/** Only watts: ZWO and MRC need the FTP. */
export const WATTS_INTERVALS = workout('watts-intervals', 'Watts Intervals', [
  { kind: 'interval', id: '1', duration: time(600), effort: watts(150) },
  { kind: 'interval', id: '2', duration: time(300), effort: watts(250) },
]);

/** A heart rate step: ZWO has none and writes a free ride. */
export const HEART_RATE = workout('heart-rate-endurance', 'Heart Rate Endurance', [
  { kind: 'interval', id: '1', duration: time(600), effort: percent(60) },
  {
    kind: 'interval',
    id: '2',
    duration: time(1200),
    effort: { kind: 'target', primary: { unit: 'bpm', start: { low: 130, high: 145 } } },
  },
]);

export const LIBRARY: readonly LibraryWorkout[] = [SWEET_SPOT, WATTS_INTERVALS, HEART_RATE].map(
  (w) => ({ id: w.id, name: w.name, sport: w.sport, steps: w.steps, workout: w }),
);
