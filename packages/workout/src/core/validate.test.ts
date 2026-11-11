// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Workout, WorkoutStep } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import { validateWorkout } from './validate.ts';

const workout = (steps: WorkoutStep[], name = 'W'): Workout => ({
  format: 'ridrs-workout',
  version: 1,
  id: 'w',
  name,
  sport: 'ride',
  source: { kind: 'user' },
  steps,
});

const codes = (steps: WorkoutStep[]) =>
  validateWorkout(workout(steps)).map((each) => `${each.code}@${each.at}`);

describe('validateWorkout', () => {
  it('takes a name of blanks for no name', () => {
    expect(validateWorkout(workout([], '  ')).map((each) => each.code)).toEqual([
      'name-missing',
      'no-steps',
    ]);
  });

  it('checks the end of a ramp and secondary targets', () => {
    expect(
      codes([
        {
          kind: 'interval',
          id: 'a',
          duration: { kind: 'time', seconds: 60 },
          effort: {
            kind: 'target',
            primary: {
              unit: 'percent-ftp',
              start: { low: 50, high: 50 },
              end: { low: 80, high: 70 },
            },
            secondary: [{ unit: 'rpm', start: { low: 100, high: 90 } }],
          },
        },
      ]),
    ).toEqual(['range-inverted@a', 'range-inverted@a']);
  });

  it('leaves watts above 300 to the source: the limit is in % FTP', () => {
    expect(
      codes([
        {
          kind: 'interval',
          id: 'a',
          duration: { kind: 'time', seconds: 10 },
          effort: { kind: 'target', primary: { unit: 'watts', start: { low: 900, high: 900 } } },
        },
      ]),
    ).toEqual([]);
  });

  it('wants distances, energies and repeats by time above zero; open and until steps have none', () => {
    expect(
      codes([
        {
          kind: 'interval',
          id: 'd',
          duration: { kind: 'distance', meters: 0 },
          effort: { kind: 'free' },
        },
        {
          kind: 'interval',
          id: 'e',
          duration: { kind: 'energy', kilocalories: 0 },
          effort: { kind: 'free' },
        },
        { kind: 'interval', id: 'o', duration: { kind: 'open' }, effort: { kind: 'max-effort' } },
        {
          kind: 'repeat',
          id: 'r',
          until: { kind: 'time', seconds: 0 },
          steps: [
            {
              kind: 'interval',
              id: 'r.1',
              duration: { kind: 'time', seconds: 1 },
              effort: { kind: 'free' },
            },
          ],
        },
      ]),
    ).toEqual(['duration-not-positive@d', 'duration-not-positive@e', 'duration-not-positive@r']);
  });

  it('finds an id used by a repeat and a step inside it', () => {
    expect(
      codes([
        {
          kind: 'repeat',
          id: 'x',
          until: { kind: 'count', reps: 2 },
          steps: [
            {
              kind: 'interval',
              id: 'x',
              duration: { kind: 'time', seconds: 1 },
              effort: { kind: 'free' },
            },
          ],
        },
      ]),
    ).toEqual(['step-id-duplicate@x']);
  });
});
