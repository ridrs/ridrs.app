// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  Workout,
  WorkoutDuration,
  WorkoutRepeatUntil,
  WorkoutStep,
  WorkoutTarget,
} from '@ridrs/contracts';
import type { WorkoutDiagnostic } from '../codec.ts';

/**
 * The editor's limits (structured-workouts.md, section 12), beyond what the schema checks: a
 * workout has a name and steps, ids are unique, a range's low end is not above its high end,
 * durations are above zero, power lies within 0–300 % FTP and a repeat runs 1–99 times.
 */
export const MAX_PERCENT_FTP = 300;
export const MAX_REPEATS = 99;

/**
 * Checks a workout that already passed its schema. Every problem is an error with a stable code;
 * `at` is the id of the step. The order follows the steps, so that the editor lists them so.
 */
export function validateWorkout(workout: Workout): WorkoutDiagnostic[] {
  const found: WorkoutDiagnostic[] = [];
  const add = (code: string, message: string, at?: string) =>
    found.push({ severity: 'error', code, message, ...(at === undefined ? {} : { at }) });

  if (workout.name.trim() === '') add('name-missing', 'The workout has no name');
  if (workout.steps.length === 0) add('no-steps', 'The workout has no steps');

  const ids = new Set<string>();

  const duration = (value: WorkoutDuration | WorkoutRepeatUntil, at: string) => {
    const amount =
      value.kind === 'time'
        ? value.seconds
        : value.kind === 'distance'
          ? value.meters
          : value.kind === 'energy'
            ? value.kilocalories
            : undefined;
    if (amount !== undefined && !(amount > 0)) {
      add('duration-not-positive', `The ${value.kind} of the step is not above zero`, at);
    }
  };

  const target = (value: WorkoutTarget, at: string) => {
    for (const range of value.end ? [value.start, value.end] : [value.start]) {
      if (range.low > range.high) {
        add('range-inverted', `The low end ${range.low} is above the high end ${range.high}`, at);
      }
      if (value.unit === 'percent-ftp' && range.high > MAX_PERCENT_FTP) {
        add('power-out-of-range', `${range.high} % FTP is above ${MAX_PERCENT_FTP} %`, at);
      }
    }
  };

  const step = (value: WorkoutStep) => {
    if (ids.has(value.id)) add('step-id-duplicate', `The id ${value.id} is used twice`, value.id);
    ids.add(value.id);
    if (value.kind === 'repeat') {
      if (
        value.until.kind === 'count' &&
        !(value.until.reps >= 1 && value.until.reps <= MAX_REPEATS)
      ) {
        add(
          'repeat-count-out-of-range',
          `${value.until.reps} repeats are outside 1–${MAX_REPEATS}`,
          value.id,
        );
      }
      duration(value.until, value.id);
      if (value.steps.length === 0) add('repeat-empty', 'The repeat has no steps', value.id);
      value.steps.forEach(step);
      return;
    }
    duration(value.duration, value.id);
    const { effort } = value;
    const targets =
      effort.kind === 'target'
        ? [effort.primary, ...(effort.secondary ?? [])]
        : effort.kind === 'free'
          ? (effort.secondary ?? [])
          : [];
    for (const each of targets) target(each, value.id);
  };

  workout.steps.forEach(step);
  return found;
}
