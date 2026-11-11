// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Workout, WorkoutInterval } from '@ridrs/contracts';
import { validateWorkout } from '@ridrs/workout';
import { describe, expect, it } from 'vitest';
import {
  addAfter,
  blankWorkout,
  cadenceOf,
  clockText,
  createStep,
  duplicateStep,
  findStep,
  idMaker,
  locate,
  moveStep,
  nudgeStep,
  parseDuration,
  setCadence,
  setPower,
  setReps,
  setSeconds,
  setUnit,
  uniqueWorkoutId,
  unwrapRepeat,
  wrapInRepeat,
  removeStep,
} from './model.ts';

const build = (...kinds: Parameters<typeof createStep>[0][]): Workout => {
  let workout = { ...blankWorkout(), name: 'W' };
  for (const kind of kinds) workout = addAfter(workout, createStep(kind, idMaker(workout)));
  return workout;
};
const ids = (workout: Workout) => workout.steps.map((step) => step.id);

describe('creating steps', () => {
  it('numbers new ids deterministically above those in use', () => {
    const workout = build('warm-up', 'interval-block', 'cool-down');
    expect(ids(workout)).toEqual(['n1', 'n2', 'n5']);
    expect(validateWorkout(workout)).toEqual([]);
  });

  it('makes every kind a valid step', () => {
    const workout = build('warm-up', 'steady', 'ramp', 'range', 'cool-down', 'free-ride', 'max-effort', 'interval-block');
    expect(validateWorkout(workout)).toEqual([]);
  });

  it('adds after the selected step, and inside a selected repeat', () => {
    let workout = build('steady', 'steady');
    workout = addAfter(workout, createStep('ramp', idMaker(workout)), 'n1');
    expect(ids(workout)).toEqual(['n1', 'n3', 'n2']);
    workout = build('interval-block');
    workout = addAfter(workout, createStep('steady', idMaker(workout)), 'n1');
    expect((workout.steps[0] as unknown as { steps: unknown[] }).steps).toHaveLength(3);
  });
});

describe('arranging steps', () => {
  it('duplicates with fresh ids, a block with its steps', () => {
    const { workout, copy } = duplicateStep(build('interval-block', 'steady'), 'n1');
    expect(ids(workout)).toEqual(['n1', copy, 'n4']);
    expect(findStep(workout.steps, copy ?? '')).toMatchObject({ kind: 'repeat' });
    expect(validateWorkout(workout)).toEqual([]);
  });

  it('removes a step', () => {
    expect(ids(removeStep(build('steady', 'ramp'), 'n1'))).toEqual(['n2']);
  });

  it('moves a step before another and into a block, never into itself', () => {
    const workout = build('steady', 'ramp', 'interval-block');
    expect(ids(moveStep(workout, 'n3', undefined, 0))).toEqual(['n3', 'n1', 'n2']);
    expect(ids(moveStep(workout, 'n1', undefined, 2))).toEqual(['n2', 'n1', 'n3']);
    expect(locate(moveStep(workout, 'n1', 'n3', 1), 'n1')).toEqual({ parent: 'n3', index: 1 });
    expect(moveStep(workout, 'n3', 'n3', 0)).toBe(workout);
  });

  it('nudges one place', () => {
    const workout = build('steady', 'ramp', 'range');
    expect(ids(nudgeStep(workout, 'n1', 1))).toEqual(['n2', 'n1', 'n3']);
    expect(ids(nudgeStep(workout, 'n3', -1))).toEqual(['n1', 'n3', 'n2']);
    expect(nudgeStep(workout, 'n1', -1)).toBe(workout);
  });

  it('wraps a step in a repeat and unwraps it again', () => {
    const wrapped = wrapInRepeat(build('steady', 'ramp'), 'n1');
    expect(wrapped.workout.steps[0]).toMatchObject({ kind: 'repeat', until: { reps: 2 } });
    expect(setReps(wrapped.workout, wrapped.repeat ?? '', 5).steps[0]).toMatchObject({ until: { reps: 5 } });
    expect(ids(unwrapRepeat(wrapped.workout, wrapped.repeat ?? ''))).toEqual(['n1', 'n2']);
  });
});

describe('editing fields', () => {
  const steady = (build('steady').steps[0]) as WorkoutInterval;

  it('sets the power and the length', () => {
    expect(setPower(steady, 'value', 350).effort).toMatchObject({ primary: { start: { low: 350, high: 350 } } });
    expect(setSeconds(steady, 720).duration).toEqual({ kind: 'time', seconds: 720 });
  });

  it('keeps a power and a repeat count within what the format allows', () => {
    expect(setPower(steady, 'value', -5).effort).toMatchObject({ primary: { start: { low: 0, high: 0 } } });
    const wrapped = wrapInRepeat(build('steady'), 'n1');
    expect(setReps(wrapped.workout, wrapped.repeat ?? '', 0).steps[0]).toMatchObject({ until: { reps: 1 } });
    expect(setReps(wrapped.workout, wrapped.repeat ?? '', 2.6).steps[0]).toMatchObject({ until: { reps: 3 } });
  });

  it('sets a range and a ramp', () => {
    const range = build('range').steps[0] as WorkoutInterval;
    expect(setPower(range, 'high', 100).effort).toMatchObject({ primary: { start: { low: 85, high: 100 } } });
    const ramp = build('ramp').steps[0] as WorkoutInterval;
    expect(setPower(ramp, 'to', 120).effort).toMatchObject({ primary: { end: { low: 120, high: 120 } } });
  });

  it('keeps the meaning of a target when the unit changes with an FTP', () => {
    expect(setUnit(steady, 'watts', 200).effort).toMatchObject({ primary: { unit: 'watts', start: { low: 150 } } });
    expect(setUnit(steady, 'power-zone').effort).toMatchObject({ primary: { unit: 'power-zone', start: { low: 2 } } });
  });

  it('adds, changes and removes a cadence beside the power', () => {
    const cadence = setCadence(steady, { low: 90, high: 90 });
    expect(cadenceOf(cadence)).toEqual({ low: 90, high: 90 });
    expect(cadenceOf(setCadence(cadence, undefined))).toBeUndefined();
    expect(setCadence(cadence, undefined).effort).not.toHaveProperty('secondary');
  });
});

describe('text', () => {
  it('reads and writes a duration', () => {
    expect(parseDuration('12:30')).toBe(750);
    expect(parseDuration('1:05:00')).toBe(3900);
    expect(parseDuration('7,5')).toBe(450);
    expect(parseDuration('abc')).toBeUndefined();
    expect(clockText(750)).toBe('12:30');
    expect(clockText(3900)).toBe('1:05:00');
  });

  it('makes a unique id of a name', () => {
    expect(uniqueWorkoutId('Süß Spot 3×12', new Set())).toBe('suss-spot-3-12');
    expect(uniqueWorkoutId('A', new Set(['a', 'a-2']))).toBe('a-3');
    expect(uniqueWorkoutId('!!!', new Set())).toBe('workout');
  });
});
