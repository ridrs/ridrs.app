// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Workout, WorkoutDuration, WorkoutEffort, WorkoutStep } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import { ergTarget, type Progress, WorkoutRun } from './player.ts';

const watts = (start: number, end?: number): WorkoutEffort => ({
  kind: 'target',
  primary: {
    unit: 'watts',
    start: { low: start, high: start },
    ...(end === undefined ? {} : { end: { low: end, high: end } }),
  },
});

const step = (id: string, duration: WorkoutDuration, effort: WorkoutEffort): WorkoutStep => ({
  kind: 'interval',
  id,
  duration,
  effort,
});

const workoutOf = (steps: WorkoutStep[]): Workout => ({
  format: 'ridrs-workout',
  version: 1,
  id: 'w',
  name: 'W',
  sport: 'virtual-ride',
  source: { kind: 'user' },
  steps,
});

const at = (ridden: number, more: Partial<Progress> = {}): Progress => ({
  ridden,
  distance: 0,
  work: 0,
  values: {},
  ...more,
});

describe('ergTarget', () => {
  it('holds the middle of a power range and leaves ERG for every other step', () => {
    expect(
      ergTarget({ kind: 'target', primary: { unit: 'watts', start: { low: 190, high: 210 } } }),
    ).toEqual({ start: 200 });
    expect(ergTarget({ kind: 'free' })).toBeUndefined();
    expect(ergTarget({ kind: 'max-effort' })).toBeUndefined();
    expect(
      ergTarget({ kind: 'target', primary: { unit: 'bpm', start: { low: 130, high: 140 } } }),
    ).toBeUndefined();
    expect(
      ergTarget({ kind: 'target', primary: { unit: 'rpm', start: { low: 90, high: 95 } } }),
    ).toBeUndefined();
  });
});

describe('WorkoutRun', () => {
  const mixed = workoutOf([
    step('a', { kind: 'time', seconds: 120 }, watts(200)),
    step('b', { kind: 'time', seconds: 60 }, watts(150, 250)),
    step('c', { kind: 'time', seconds: 60 }, { kind: 'free' }),
  ]);

  it('passes time steps exactly at their length and ramps linearly', () => {
    const run = new WorkoutRun(mixed);
    expect(run.begin(at(0))).toEqual([{ index: 0, stepId: 'a' }]);
    expect(run.target(at(0))).toBe(200);
    expect(run.advance(at(119_000))).toEqual([]);
    expect(run.advance(at(120_000))).toEqual([{ index: 1, stepId: 'b' }]);
    expect(run.target(at(120_000))).toBe(150);
    expect(run.target(at(121_000))).toBe(152);
    expect(run.target(at(150_000))).toBe(200);
    expect(run.advance(at(180_000))).toEqual([{ index: 2, stepId: 'c' }]);
    expect(run.target(at(180_000))).toBeNull();
    expect(run.advance(at(240_000))).toEqual([]);
    expect(run.finished).toBe(true);
  });

  it('does not drift when a look comes late: the next step starts at the exact end', () => {
    const run = new WorkoutRun(mixed);
    run.begin(at(0));
    run.advance(at(120_700));
    // The ramp began at 120 s, so at 150 s it is half way.
    expect(run.target(at(150_000))).toBe(200);
  });

  it('passes several steps in one late look, in order', () => {
    const run = new WorkoutRun(mixed);
    run.begin(at(0));
    expect(run.advance(at(200_000)).map((s) => s.index)).toEqual([1, 2]);
  });

  it('skips to the next step and starts it now', () => {
    const run = new WorkoutRun(mixed);
    run.begin(at(0));
    expect(run.skip(at(30_000))).toEqual([{ index: 1, stepId: 'b' }]);
    expect(run.target(at(60_000))).toBe(200);
  });

  it('waits for "Next step" in an open step', () => {
    const run = new WorkoutRun(
      workoutOf([step('a', { kind: 'open' }, watts(180)), step('b', { kind: 'time', seconds: 60 }, watts(220))]),
    );
    run.begin(at(0));
    expect(run.advance(at(3_600_000))).toEqual([]);
    expect(run.skip(at(3_600_000))).toEqual([{ index: 1, stepId: 'b' }]);
    expect(run.target(at(3_600_000))).toBe(220);
  });

  it('ends a distance step by the virtual distance, an energy step by the work', () => {
    const run = new WorkoutRun(
      workoutOf([
        step('a', { kind: 'distance', meters: 100 }, watts(100, 200)),
        step('b', { kind: 'energy', kilocalories: 10 }, watts(150)),
        step('c', { kind: 'time', seconds: 10 }, watts(150)),
      ]),
    );
    run.begin(at(0, { distance: 5 }));
    expect(run.target(at(10_000, { distance: 55 }))).toBe(150);
    expect(run.advance(at(10_000, { distance: 104 }))).toEqual([]);
    expect(run.advance(at(11_000, { distance: 105, work: 1000 }))).toEqual([{ index: 1, stepId: 'b' }]);
    expect(run.advance(at(50_000, { distance: 400, work: 10_999 }))).toEqual([]);
    expect(run.advance(at(51_000, { distance: 410, work: 11_000 }))).toEqual([{ index: 2, stepId: 'c' }]);
  });

  it('ends an `until` step once its value passes the bound, never without a value', () => {
    const run = new WorkoutRun(
      workoutOf([
        step('a', { kind: 'until', unit: 'bpm', comparison: 'below', value: 120 }, { kind: 'free' }),
        step('b', { kind: 'until', unit: 'percent-lthr', comparison: 'above', value: 90 }, { kind: 'free' }),
      ]),
    );
    run.begin(at(0));
    expect(run.advance(at(1000))).toEqual([]);
    expect(run.advance(at(2000, { values: { bpm: 125 } }))).toEqual([]);
    expect(run.advance(at(3000, { values: { bpm: 119 } }))).toEqual([{ index: 1, stepId: 'b' }]);
    // A unit the player cannot measure ends only by "Next step".
    expect(run.advance(at(4000, { values: { bpm: 200, watts: 400 } }))).toEqual([]);
  });

  it('unrolls repeats and passes zero-length steps at once', () => {
    const run = new WorkoutRun(
      workoutOf([
        step('z', { kind: 'time', seconds: 0 }, watts(100)),
        {
          kind: 'repeat',
          id: 'r',
          until: { kind: 'count', reps: 2 },
          steps: [step('on', { kind: 'time', seconds: 10 }, watts(300))],
        },
      ]),
    );
    expect(run.begin(at(0))).toEqual([
      { index: 0, stepId: 'z' },
      { index: 1, stepId: 'on' },
    ]);
    expect(run.advance(at(10_000))).toEqual([{ index: 2, stepId: 'on' }]);
    run.advance(at(20_000));
    expect(run.finished).toBe(true);
    expect(run.target(at(20_000))).toBeNull();
  });

  it('is over at once for a workout without steps', () => {
    const run = new WorkoutRun(workoutOf([]));
    expect(run.begin(at(0))).toEqual([]);
    expect(run.finished).toBe(true);
  });
});
