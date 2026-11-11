// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  AthleteProfile,
  Workout,
  WorkoutDuration,
  WorkoutEffort,
  WorkoutRange,
  WorkoutRepeatUntil,
  WorkoutStep,
  WorkoutTarget,
  WorkoutTargetUnit,
} from '@ridrs/contracts';
import { type TrainingZones, zoneBounds } from './zones.ts';

/**
 * Resolving targets with the athlete profile (ADR 0081, 0082): % FTP and power zones become
 * watts, % LTHR, % of the maximum heart rate and heart rate zones become bpm. Showing resolves
 * live, a ride once at its start; the workout itself never stores a converted value. What cannot
 * be resolved says why; nothing is guessed.
 */

/** What resolving reads of the athlete profile: what the chart capability is given. */
export type WorkoutAthlete = Partial<
  Pick<AthleteProfile, 'ftp' | 'lthr' | 'maxHeartRate' | 'powerZones' | 'heartRateZones'>
>;

/** Why a target cannot be resolved: the profile lacks a value, or the zone does not exist. */
export type ResolveFailure =
  | 'no-ftp'
  | 'no-power-zones'
  | 'no-lthr'
  | 'no-max-heart-rate'
  | 'no-heart-rate-zones'
  | 'unknown-zone'
  /** A zone as the bound of an `until` condition: one value, not a range. */
  | 'zone-condition';

export type TargetResolution =
  | {
      readonly ok: true;
      /** In `watts` or `bpm` for power and heart rate; other units as they were. */
      readonly target: WorkoutTarget;
      /**
       * The target reaches into the last, open zone: its upper end is held at that zone's lower
       * bound, and the rider may go above.
       */
      readonly openAbove: boolean;
    }
  | { readonly ok: false; readonly reason: ResolveFailure };

const POWER_UNITS: ReadonlySet<WorkoutTargetUnit> = new Set(['percent-ftp', 'watts', 'power-zone']);
const HEART_RATE_UNITS: ReadonlySet<WorkoutTargetUnit> = new Set([
  'percent-lthr',
  'percent-max-hr',
  'bpm',
  'hr-zone',
]);

export const isPowerUnit = (unit: WorkoutTargetUnit) => POWER_UNITS.has(unit);
export const isHeartRateUnit = (unit: WorkoutTargetUnit) => HEART_RATE_UNITS.has(unit);

type Scale =
  | { readonly ok: true; readonly unit: WorkoutTargetUnit; readonly factor: number }
  | {
      readonly ok: true;
      readonly unit: WorkoutTargetUnit;
      readonly zones: TrainingZones;
      readonly factor: number;
    }
  | { readonly ok: false; readonly reason: ResolveFailure };

/** How a unit becomes watts or bpm with this athlete: a factor, or zones and a factor. */
function scaleOf(unit: WorkoutTargetUnit, athlete: WorkoutAthlete): Scale | undefined {
  switch (unit) {
    case 'percent-ftp':
      return athlete.ftp ? { ok: true, unit: 'watts', factor: athlete.ftp / 100 } : fail('no-ftp');
    case 'power-zone':
      if (!athlete.ftp) return fail('no-ftp');
      if (!athlete.powerZones) return fail('no-power-zones');
      return { ok: true, unit: 'watts', zones: athlete.powerZones, factor: athlete.ftp / 100 };
    case 'percent-lthr':
      return athlete.lthr ? { ok: true, unit: 'bpm', factor: athlete.lthr / 100 } : fail('no-lthr');
    case 'percent-max-hr':
      return athlete.maxHeartRate
        ? { ok: true, unit: 'bpm', factor: athlete.maxHeartRate / 100 }
        : fail('no-max-heart-rate');
    case 'hr-zone':
      return athlete.heartRateZones
        ? { ok: true, unit: 'bpm', zones: athlete.heartRateZones, factor: 1 }
        : fail('no-heart-rate-zones');
    default:
      // watts, bpm, cadence, speed, RPE: nothing to resolve.
      return undefined;
  }
}

const fail = (reason: ResolveFailure) => ({ ok: false, reason }) as const;

type RangeResolution =
  | { readonly ok: true; readonly range: WorkoutRange; readonly openAbove: boolean }
  | { readonly ok: false; readonly reason: ResolveFailure };

/** Whole watts and bpm: what a trainer takes and a FIT file holds. */
const whole = (value: number) => Math.round(value);

function resolveRange(range: WorkoutRange, scale: Scale & { ok: true }): RangeResolution {
  if (!('zones' in scale)) {
    return {
      ok: true,
      range: { low: whole(range.low * scale.factor), high: whole(range.high * scale.factor) },
      openAbove: false,
    };
  }
  const lowest = zoneBounds(range.low, scale.zones);
  const highest = zoneBounds(range.high, scale.zones);
  if (!lowest || !highest) return fail('unknown-zone');
  const top = highest.high ?? highest.low;
  return {
    ok: true,
    range: { low: whole(lowest.low * scale.factor), high: whole(top * scale.factor) },
    openAbove: highest.high === undefined,
  };
}

/** Resolves one target: watts for power, bpm for heart rate, other units as they are. */
export function resolveTarget(target: WorkoutTarget, athlete: WorkoutAthlete): TargetResolution {
  const scale = scaleOf(target.unit, athlete);
  if (!scale) return { ok: true, target, openAbove: false };
  if (!scale.ok) return scale;
  const start = resolveRange(target.start, scale);
  if (!start.ok) return start;
  const end = target.end ? resolveRange(target.end, scale) : undefined;
  if (end && !end.ok) return end;
  return {
    ok: true,
    target: {
      ...target,
      unit: scale.unit,
      start: start.range,
      ...(end ? { end: end.range } : {}),
    },
    openAbove: start.openAbove || (end?.openAbove ?? false),
  };
}

/** Where in a step a resolution failed or reached into an open zone. */
export interface ResolveIssue {
  readonly stepId: string;
  /** The primary target, a secondary one (with its index), the `until` duration or repeat. */
  readonly at: 'primary' | 'secondary' | 'duration' | 'repeat';
  readonly index?: number;
  readonly code: ResolveFailure | 'open-zone';
}

export interface WorkoutResolution {
  /** The same workout with every resolvable target in watts or bpm; the rest as it was. */
  readonly workout: Workout;
  readonly issues: readonly ResolveIssue[];
}

/**
 * Resolves a whole workout for a ride, as the briefing does at its start: targets, `until`
 * durations and repeat conditions. The given workout is not changed.
 */
export function resolveWorkout(workout: Workout, athlete: WorkoutAthlete): WorkoutResolution {
  const issues: ResolveIssue[] = [];

  const target = (
    original: WorkoutTarget,
    stepId: string,
    at: 'primary' | 'secondary',
    index?: number,
  ): WorkoutTarget => {
    const where = { stepId, at, ...(index === undefined ? {} : { index }) };
    const resolved = resolveTarget(original, athlete);
    if (!resolved.ok) {
      issues.push({ ...where, code: resolved.reason });
      return original;
    }
    if (resolved.openAbove) issues.push({ ...where, code: 'open-zone' });
    return resolved.target;
  };

  const secondaries = (list: readonly WorkoutTarget[] | undefined, stepId: string) =>
    list?.map((item, index) => target(item, stepId, 'secondary', index));

  const effort = (original: WorkoutEffort, stepId: string): WorkoutEffort => {
    switch (original.kind) {
      case 'target': {
        const primary = target(original.primary, stepId, 'primary');
        const secondary = secondaries(original.secondary, stepId);
        return { ...original, primary, ...(secondary ? { secondary } : {}) };
      }
      case 'free': {
        const secondary = secondaries(original.secondary, stepId);
        return { ...original, ...(secondary ? { secondary } : {}) };
      }
      default:
        return original;
    }
  };

  /** A single bound of a condition: a % becomes watts or bpm; a zone is not one value. */
  const condition = <T extends { unit: WorkoutTargetUnit; value: number }>(
    original: T,
    stepId: string,
    at: 'duration' | 'repeat',
  ): T => {
    const scale = scaleOf(original.unit, athlete);
    if (!scale) return original;
    if (!scale.ok || 'zones' in scale) {
      issues.push({ stepId, at, code: scale.ok ? 'zone-condition' : scale.reason });
      return original;
    }
    return { ...original, unit: scale.unit, value: whole(original.value * scale.factor) };
  };

  const step = (original: WorkoutStep): WorkoutStep => {
    if (original.kind === 'repeat') {
      const until: WorkoutRepeatUntil =
        original.until.kind === 'condition'
          ? condition(original.until, original.id, 'repeat')
          : original.until;
      return { ...original, until, steps: original.steps.map(step) };
    }
    const duration: WorkoutDuration =
      original.duration.kind === 'until'
        ? condition(original.duration, original.id, 'duration')
        : original.duration;
    return { ...original, duration, effort: effort(original.effort, original.id) };
  };

  return { workout: { ...workout, steps: workout.steps.map(step) }, issues };
}
