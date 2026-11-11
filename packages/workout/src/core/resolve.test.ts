// SPDX-License-Identifier: AGPL-3.0-or-later

import { type Workout, type WorkoutTarget, workoutSchema } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import { resolveTarget, resolveWorkout } from './resolve.ts';
import { defaultHeartRateZones, defaultPowerZones } from './zones.ts';

const athlete = {
  ftp: 250,
  lthr: 170,
  maxHeartRate: 190,
  powerZones: defaultPowerZones(),
  heartRateZones: defaultHeartRateZones(170),
};

const exact = (unit: WorkoutTarget['unit'], value: number): WorkoutTarget => ({
  unit,
  start: { low: value, high: value },
});

/** Freezes deeply, so that a test fails when resolving writes into its input. */
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) frozen(inner);
    Object.freeze(value);
  }
  return value;
}

describe('resolveTarget', () => {
  it('resolves a ramp across zones from the bottom of the first to the top of the last', () => {
    // Z1→Z3: 0–55 % at the start, 75–90 % at the end; 0, 137.5 → 138, 187.5 → 188, 225 W.
    const ramp: WorkoutTarget = {
      unit: 'power-zone',
      start: { low: 1, high: 1 },
      end: { low: 3, high: 3 },
    };
    expect(resolveTarget(ramp, athlete)).toEqual({
      ok: true,
      target: { unit: 'watts', start: { low: 0, high: 138 }, end: { low: 188, high: 225 } },
      openAbove: false,
    });
  });

  it('resolves a range of zones Z2–Z3 to 138–225 W', () => {
    const target: WorkoutTarget = { unit: 'power-zone', start: { low: 2, high: 3 } };
    expect(resolveTarget(target, athlete)).toMatchObject({
      ok: true,
      target: { start: { low: 138, high: 225 } },
    });
  });

  it('keeps the averaging of a FIT target', () => {
    const target: WorkoutTarget = { ...exact('percent-ftp', 100), averaging: '3s' };
    expect(resolveTarget(target, athlete)).toMatchObject({
      ok: true,
      target: { unit: 'watts', start: { low: 250, high: 250 }, averaging: '3s' },
    });
  });

  it('leaves speed and RPE as they are', () => {
    for (const target of [exact('percent-threshold-speed', 90), exact('rpe', 7)]) {
      expect(resolveTarget(target, {})).toEqual({ ok: true, target, openAbove: false });
    }
  });

  it('never guesses an FTP from nothing', () => {
    expect(resolveTarget(exact('percent-ftp', 90), { powerZones: defaultPowerZones() })).toEqual({
      ok: false,
      reason: 'no-ftp',
    });
  });
});

describe('resolveWorkout', () => {
  const workout: Workout = frozen({
    format: 'ridrs-workout',
    version: 1,
    id: 'w',
    name: 'Mixed',
    sport: 'ride',
    source: { kind: 'user' },
    steps: [
      {
        kind: 'interval',
        id: '1',
        duration: { kind: 'until', unit: 'percent-max-hr', comparison: 'above', value: 80 },
        effort: {
          kind: 'target',
          primary: exact('percent-ftp', 90),
          secondary: [{ unit: 'rpm', start: { low: 95, high: 105 } }, exact('percent-lthr', 90)],
        },
      },
      {
        kind: 'repeat',
        id: '2',
        until: { kind: 'condition', unit: 'hr-zone', comparison: 'below', value: 2 },
        steps: [
          {
            kind: 'interval',
            id: '2.1',
            duration: { kind: 'time', seconds: 30 },
            effort: { kind: 'free', secondary: [exact('power-zone', 7)] },
          },
          {
            kind: 'interval',
            id: '2.2',
            duration: { kind: 'time', seconds: 30 },
            effort: { kind: 'max-effort' },
          },
        ],
      },
    ],
  });

  it('resolves targets, secondary targets and until durations, and stays a valid workout', () => {
    const { workout: resolved, issues } = resolveWorkout(workout, athlete);
    expect(workoutSchema.safeParse(resolved).success).toBe(true);
    const first = resolved.steps[0];
    expect(first).toMatchObject({
      // 80 % of 190 bpm = 152 bpm
      duration: { kind: 'until', unit: 'bpm', comparison: 'above', value: 152 },
      effort: {
        primary: exact('watts', 225),
        // 90 % of 170 bpm = 153 bpm; cadence as it was
        secondary: [{ unit: 'rpm', start: { low: 95, high: 105 } }, exact('bpm', 153)],
      },
    });
    expect(issues).toEqual([
      { stepId: '2', at: 'repeat', code: 'zone-condition' },
      { stepId: '2.1', at: 'secondary', index: 0, code: 'open-zone' },
    ]);
  });

  it('holds an open zone at its lower bound and says so', () => {
    const { workout: resolved } = resolveWorkout(workout, athlete);
    const repeat = resolved.steps[1];
    expect(repeat?.kind === 'repeat' && repeat.steps[0]).toMatchObject({
      effort: { kind: 'free', secondary: [exact('watts', 375)] },
    });
  });

  it('names every target it cannot resolve and keeps it', () => {
    const { workout: resolved, issues } = resolveWorkout(workout, {});
    expect(resolved.steps[0]).toEqual(workout.steps[0]);
    expect(issues).toEqual([
      { stepId: '1', at: 'duration', code: 'no-max-heart-rate' },
      { stepId: '1', at: 'primary', code: 'no-ftp' },
      { stepId: '1', at: 'secondary', index: 1, code: 'no-lthr' },
      { stepId: '2', at: 'repeat', code: 'no-heart-rate-zones' },
      { stepId: '2.1', at: 'secondary', index: 0, code: 'no-ftp' },
    ]);
  });
});
