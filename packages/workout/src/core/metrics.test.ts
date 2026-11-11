// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Workout, WorkoutEffort, WorkoutStep, WorkoutTarget } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import { normalizedPower, workoutMetrics } from './metrics.ts';

const workout = (steps: WorkoutStep[]): Workout => ({
  format: 'ridrs-workout',
  version: 1,
  id: 'w',
  name: 'W',
  sport: 'ride',
  source: { kind: 'user' },
  steps,
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

describe('normalizedPower', () => {
  it('is undefined without samples and the mean below 30 of them', () => {
    expect(normalizedPower([])).toBeUndefined();
    expect(normalizedPower([100, 200])).toBe(150);
  });

  it('averages the fourth power of the 30-second rolling average', () => {
    // 30 s at 0, then 30 s at 100: 31 averages, 100 k / 30 for k = 0 … 30.
    // Σ k⁴ (k = 1 … 30) = 30 · 31 · 61 · (3 · 30² + 3 · 30 − 1) / 30 = 5 273 999.
    // NP = 100 / 30 × (5 273 999 / 31)^¼ = 67.7
    const samples = [...Array(30).fill(0), ...Array(30).fill(100)];
    expect(normalizedPower(samples)).toBeCloseTo((100 / 30) * (5_273_999 / 31) ** 0.25, 9);
    expect(normalizedPower(samples)).toBeCloseTo(67.7, 1);
  });
});

describe('workoutMetrics', () => {
  it('counts a last partial second by its share', () => {
    // 10.5 s at 200 W: 2.1 kJ
    const found = workoutMetrics(workout([step('a', 10.5, at('watts', 200))]));
    expect(found.durationSeconds).toBe(10.5);
    expect(found.kilojoules).toBeCloseTo(2.1, 9);
  });

  it('gives a workout in watts its load once there is an FTP', () => {
    // 200 of 250 W: IF 0.8; 0.5 h × 0.8² × 100 = 32
    const found = workoutMetrics(workout([step('a', 1800, at('watts', 200))]), { ftp: 250 });
    expect(found.basis).toBe('percent-ftp');
    expect(found.intensityFactor).toBeCloseTo(0.8, 9);
    expect(found.trainingLoad).toBeCloseTo(32, 9);
  });

  it('uses the zones of the athlete for the time per zone', () => {
    const zones = [{ upTo: 60 }, { upTo: 100 }, {}];
    const found = workoutMetrics(workout([step('a', 600, at('percent-ftp', 90))]), {
      ftp: 200,
      powerZones: zones,
    });
    expect(found.timeInZones).toEqual([0, 600, 0]);
  });

  it('counts max effort at an assumed 150 %, outside every zone, and marks it', () => {
    const found = workoutMetrics(workout([step('a', 60, { kind: 'max-effort' })]), { ftp: 200 });
    expect(found.intensityEstimated).toBe(true);
    expect(found.secondsWithoutPowerTarget).toBe(60);
    expect(found.timeInZones?.every((seconds) => seconds === 0)).toBe(true);
    // 300 W for 60 s: 18 kJ
    expect(found.kilojoules).toBeCloseTo(18, 9);
  });

  it("draws a zone target from Coggan's zones when the profile has none, and marks it", () => {
    // Z2 = 55–75 %, at its middle of 65 %
    const found = workoutMetrics(workout([step('a', 3600, at('power-zone', 2))]));
    expect(found.normalizedPowerPercent).toBeCloseTo(65, 9);
    expect(found.intensityEstimated).toBe(true);
    expect(found.ergStepIds).toEqual([]);
  });

  it('has nothing to say about an empty workout', () => {
    expect(workoutMetrics(workout([]), { ftp: 250 })).toEqual({
      durationSeconds: 0,
      durationEstimated: false,
      intensityEstimated: false,
      basis: 'percent-ftp',
      kilojoules: 0,
      timeInZones: [0, 0, 0, 0, 0, 0, 0],
      secondsWithoutPowerTarget: 0,
      ergStepIds: [],
    });
  });

  it('follows the assumptions it is given', () => {
    const found = workoutMetrics(
      workout([step('a', 3600, { kind: 'free' })]),
      {},
      {
        estimates: { freeRide: 50 },
      },
    );
    // an hour at 50 %: IF 0.5, load 25
    expect(found.trainingLoad).toBeCloseTo(25, 9);
  });
});
