// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Workout, WorkoutEffort, WorkoutStep, WorkoutTarget } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import { layoutWorkout } from './layout.ts';

const workout = (steps: WorkoutStep[], extra: Partial<Workout> = {}): Workout => ({
  format: 'ridrs-workout',
  version: 1,
  id: 'w',
  name: 'W',
  sport: 'ride',
  source: { kind: 'user' },
  steps,
  ...extra,
});

const at = (unit: WorkoutTarget['unit'], value: number): WorkoutEffort => ({
  kind: 'target',
  primary: { unit, start: { low: value, high: value } },
});

const step = (id: string, seconds: number, effort: WorkoutEffort): WorkoutStep => ({
  kind: 'interval',
  id,
  duration: { kind: 'time', seconds },
  effort,
});

const size = { width: 600, height: 150 };

describe('layoutWorkout', () => {
  it('lays out an empty workout without NaN', () => {
    const layout = layoutWorkout(workout([]), size);
    expect(layout.shapes).toEqual([]);
    expect(layout.timeTicks).toEqual([]);
    expect(JSON.stringify(layout)).not.toContain('null');
  });

  it('brackets nested repeats, the outer one at depth 0', () => {
    // 2 × [ 2 × (a 60 s), b 60 s ] = 360 s; 600 px: 1 px = 0.6 s
    const layout = layoutWorkout(
      workout([
        {
          kind: 'repeat',
          id: 'o',
          until: { kind: 'count', reps: 2 },
          steps: [
            {
              kind: 'repeat',
              id: 'i',
              until: { kind: 'count', reps: 2 },
              steps: [step('a', 60, at('percent-ftp', 100))],
            },
            step('b', 60, at('percent-ftp', 50)),
          ],
        },
      ]),
      size,
    );
    expect(layout.brackets).toEqual([
      { repeatId: 'o', count: 2, x0: 0, x1: 600, depth: 0 },
      // the inner repeat once per round of the outer one: 0–120 s and 180–300 s
      { repeatId: 'i', count: 2, x0: 0, x1: 200, depth: 1 },
      { repeatId: 'i', count: 2, x0: 300, x1: 500, depth: 1 },
    ]);
  });

  it("scales a watt axis to 150 % of the workout's reference FTP", () => {
    const layout = layoutWorkout(
      workout([step('a', 60, at('watts', 200))], { referenceFtp: 300 }),
      size,
    );
    expect(layout.axis).toMatchObject({ unit: 'watts', max: 450 });
    expect(layout.axis.ticks.map((tick) => tick.value)).toEqual([0, 100, 200, 300, 400]);
  });

  it("draws a zone target from Coggan's zones without the profile's, estimated", () => {
    const [shape] = layoutWorkout(workout([step('a', 60, at('power-zone', 2))]), size).shapes;
    // Z2 = 55–75 %: a band, at its middle of 65 %
    expect(shape?.polygon[1]).toEqual([0, 85]);
    expect(shape?.band).toEqual([
      [0, 75],
      [600, 75],
      [600, 95],
      [0, 95],
    ]);
    expect(shape?.heightEstimated).toBe(true);
    expect(shape?.zone).toBeUndefined();
  });

  it('remembers by the values of the athlete, not by its object', () => {
    const plan = workout([step('a', 60, at('percent-ftp', 100))]);
    const first = layoutWorkout(plan, { ...size, athlete: { ftp: 250 } });
    expect(layoutWorkout(plan, { ...size, athlete: { ftp: 250 } })).toBe(first);
    expect(layoutWorkout(plan, { ...size, athlete: { ftp: 260 } })).not.toBe(first);
    expect(layoutWorkout(plan, { ...size, athlete: { ftp: 250 }, variant: 'mini' })).not.toBe(
      first,
    );
  });

  it('ticks a long workout every 30 minutes', () => {
    const layout = layoutWorkout(workout([step('a', 3 * 3600, at('percent-ftp', 60))]), size);
    expect(layout.timeTicks.map((tick) => tick.value / 60)).toEqual([0, 30, 60, 90, 120, 150, 180]);
  });

  it('gives the mini chart its FTP line but no axes', () => {
    const layout = layoutWorkout(workout([step('a', 60, at('percent-ftp', 60))]), {
      width: 200,
      height: 56,
      variant: 'mini',
    });
    expect(layout.ftpLine?.y).toBeCloseTo(56 - (100 / 150) * 56, 9);
    expect(layout.axis.ticks).toEqual([]);
    expect(layout.timeTicks).toEqual([]);
  });

  it('describes no main set when nothing rises above the mean', () => {
    const layout = layoutWorkout(workout([step('a', 600, at('percent-ftp', 60))]), size);
    expect(layout.summary.mainIntervals).toBeUndefined();
  });
});
