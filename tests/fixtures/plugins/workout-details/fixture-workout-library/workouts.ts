// SPDX-License-Identifier: AGPL-3.0-or-later

import type { LibraryWorkout, PlannedWorkout, Workout } from '@ridrs/contracts';

/**
 * The workouts of the details scenarios, written by hand for them: one canonical workout with
 * author and licence (a ramp, a counted repeat, a cadence beside the power), and one library
 * entry without a canonical workout whose steps go by watts, heart rate, distance, a bound and the
 * lap button (structured-workouts.md, F5).
 */
export const SWEET_SPOT: Workout = {
  format: 'ridrs-workout',
  version: 1,
  id: 'sweet-spot-3x12',
  name: 'Sweet Spot 3x12',
  description: 'Three blocks of twelve minutes just below the threshold.',
  sport: 'virtual-ride',
  author: 'ridrs',
  license: 'CC-BY-SA-4.0',
  focus: 'sweet-spot',
  source: { kind: 'builtin', format: 'zwo' },
  steps: [
    {
      kind: 'interval',
      id: '1',
      intensity: 'warm-up',
      duration: { kind: 'time', seconds: 600 },
      effort: {
        kind: 'target',
        primary: { unit: 'percent-ftp', start: { low: 50, high: 50 }, end: { low: 75, high: 75 } },
      },
    },
    {
      kind: 'repeat',
      id: '2',
      until: { kind: 'count', reps: 3 },
      steps: [
        {
          kind: 'interval',
          id: '2.1',
          name: 'Sweet spot',
          intensity: 'interval',
          duration: { kind: 'time', seconds: 720 },
          effort: {
            kind: 'target',
            primary: { unit: 'percent-ftp', start: { low: 90, high: 90 } },
            secondary: [{ unit: 'rpm', start: { low: 85, high: 95 } }],
          },
        },
        {
          kind: 'interval',
          id: '2.2',
          name: 'Recovery',
          intensity: 'recovery',
          duration: { kind: 'time', seconds: 240 },
          effort: {
            kind: 'target',
            primary: { unit: 'percent-ftp', start: { low: 55, high: 55 } },
          },
        },
      ],
    },
    {
      kind: 'interval',
      id: '3',
      intensity: 'cool-down',
      duration: { kind: 'time', seconds: 300 },
      effort: {
        kind: 'target',
        primary: { unit: 'percent-ftp', start: { low: 65, high: 65 }, end: { low: 45, high: 45 } },
      },
    },
  ],
};

export const LIBRARY: readonly LibraryWorkout[] = [
  {
    id: SWEET_SPOT.id,
    name: SWEET_SPOT.name,
    sport: SWEET_SPOT.sport,
    durationSeconds: 3780,
    steps: SWEET_SPOT.steps,
    workout: SWEET_SPOT,
  },
  {
    id: 'heart-rate-endurance',
    name: 'Heart Rate Endurance',
    sport: 'ride',
    description: 'Ridden by feel and by heart rate.',
    steps: [
      {
        kind: 'interval',
        id: '1',
        name: 'Easy spin',
        duration: { kind: 'time', seconds: 600 },
        effort: { kind: 'target', primary: { unit: 'watts', start: { low: 150, high: 150 } } },
      },
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
      {
        kind: 'interval',
        id: '4',
        name: 'Until recovered',
        duration: { kind: 'until', unit: 'bpm', comparison: 'below', value: 110 },
        effort: { kind: 'free' },
      },
      {
        kind: 'interval',
        id: '5',
        name: 'Free spin',
        duration: { kind: 'open' },
        effort: { kind: 'free' },
      },
    ],
  },
];

export const CALENDAR: readonly PlannedWorkout[] = [
  {
    id: 'planned-1',
    date: '2026-11-12',
    name: SWEET_SPOT.name,
    sport: SWEET_SPOT.sport,
    steps: SWEET_SPOT.steps,
    library: { from: 'fixture-library', workoutId: SWEET_SPOT.id },
  },
];
