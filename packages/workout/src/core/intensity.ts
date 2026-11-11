// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Workout, WorkoutRange, WorkoutStep, WorkoutTarget } from '@ridrs/contracts';
import { isHeartRateUnit, type WorkoutAthlete } from './resolve.ts';
import type { TimelineSegment } from './timeline.ts';
import { defaultPowerZones, zoneBounds } from './zones.ts';

/**
 * The power of a segment as the metrics and the chart see it, in one unit for the whole workout.
 * This is for showing and deriving only; a ride resolves its targets with `resolveWorkout`.
 */

/**
 * The intensities assumed for steps without a power target, in % FTP. Rough on purpose: they
 * place a step in the chart and in the load, and everything they touch is marked estimated.
 */
export interface IntensityEstimates {
  /** A free ride: an easy endurance pace. */
  readonly freeRide: number;
  /** All out: the top of the chart's scale. */
  readonly maxEffort: number;
  /** A heart rate target: steps by heart rate are mostly endurance work. */
  readonly heartRate: number;
  /** Any other target (cadence, speed, RPE alone), or watts without an FTP on a % axis. */
  readonly other: number;
}

export const INTENSITY_ESTIMATES: IntensityEstimates = {
  freeRide: 60,
  maxEffort: 150,
  heartRate: 65,
  other: 60,
};

/**
 * Without an FTP, assumed intensities on a watt axis are taken of the workout's reference FTP
 * (an ERG or MRC header), else of this one.
 */
export const ASSUMED_FTP_WATTS = 200;

/**
 * The unit of a workout's intensity: % FTP whenever an FTP is known or the workout has % or zone
 * targets; watts for a workout in watts without an FTP.
 */
export type PowerBasis = 'percent-ftp' | 'watts';

/** Why a segment is drawn hatched: no power target, or a power target for an open length. */
export type IntensityMarker = 'free' | 'max-effort' | 'heart-rate' | 'open' | 'other';

export interface SegmentIntensity {
  /** In the basis unit; `end` equals `start` for a steady step. */
  readonly start: WorkoutRange;
  readonly end: WorkoutRange;
  /** A ramp: `end` differs from `start`. */
  readonly ramp: boolean;
  /** The step has a power target the basis holds; else the intensity is assumed. */
  readonly power: boolean;
  /** The height is an assumption (no power target, or zones of the default set). */
  readonly estimated: boolean;
  readonly marker?: IntensityMarker;
}

export interface IntensityContext {
  readonly basis: PowerBasis;
  readonly athlete: WorkoutAthlete;
  readonly referenceFtp?: number;
  readonly estimates: IntensityEstimates;
}

function* intervals(steps: readonly WorkoutStep[]): Generator<WorkoutStep & { kind: 'interval' }> {
  for (const step of steps) {
    if (step.kind === 'repeat') yield* intervals(step.steps);
    else yield step;
  }
}

/** The basis of a workout for an athlete. */
export function powerBasis(workout: Workout, athlete: WorkoutAthlete = {}): PowerBasis {
  if (athlete.ftp) return 'percent-ftp';
  let watts = false;
  for (const step of intervals(workout.steps)) {
    if (step.effort.kind !== 'target') continue;
    const { unit } = step.effort.primary;
    if (unit === 'percent-ftp' || unit === 'power-zone') return 'percent-ftp';
    watts ||= unit === 'watts';
  }
  return watts ? 'watts' : 'percent-ftp';
}

export function intensityContext(
  workout: Workout,
  athlete: WorkoutAthlete = {},
  estimates: Partial<IntensityEstimates> = {},
): IntensityContext {
  return {
    basis: powerBasis(workout, athlete),
    athlete,
    ...(workout.referenceFtp === undefined ? {} : { referenceFtp: workout.referenceFtp }),
    estimates: { ...INTENSITY_ESTIMATES, ...estimates },
  };
}

const range = (low: number, high = low): WorkoutRange => ({ low, high });

/** A target in the basis unit, or undefined when the basis cannot hold it. */
function inBasis(
  target: WorkoutTarget,
  context: IntensityContext,
):
  | { readonly start: WorkoutRange; readonly end?: WorkoutRange; readonly estimated: boolean }
  | undefined {
  const { basis, athlete } = context;
  const ftp = athlete.ftp;
  const scale = (factor: number) => (value: WorkoutRange) =>
    range(value.low * factor, value.high * factor);
  const map = (convert: (value: WorkoutRange) => WorkoutRange | undefined, estimated = false) => {
    const start = convert(target.start);
    const end = target.end && convert(target.end);
    if (!start || (target.end && !end)) return undefined;
    return { start, ...(end ? { end } : {}), estimated };
  };
  switch (target.unit) {
    case 'percent-ftp':
      if (basis === 'percent-ftp') return map((value) => value);
      return undefined;
    case 'watts':
      if (basis === 'watts') return map((value) => value);
      return ftp ? map(scale(100 / ftp)) : undefined;
    case 'power-zone': {
      if (basis !== 'percent-ftp') return undefined;
      // Showing a zone target needs zones; without the profile's, Coggan's stand in, marked.
      const zones = athlete.powerZones ?? defaultPowerZones();
      return map((value) => {
        const lowest = zoneBounds(value.low, zones);
        const highest = zoneBounds(value.high, zones);
        if (!lowest || !highest) return undefined;
        return range(lowest.low, highest.high ?? highest.low);
      }, athlete.powerZones === undefined);
    }
    default:
      return undefined;
  }
}

/** The power of a segment in the basis unit, or the assumed one with its marker. */
export function segmentIntensity(
  segment: Pick<TimelineSegment, 'effort' | 'duration'>,
  context: IntensityContext,
): SegmentIntensity {
  const { effort, duration } = segment;
  const openLength = duration.kind === 'open' || duration.kind === 'until';
  if (effort.kind === 'target') {
    const found = inBasis(effort.primary, context);
    if (found) {
      const end = found.end ?? found.start;
      return {
        start: found.start,
        end,
        ramp: end.low !== found.start.low || end.high !== found.start.high,
        power: true,
        estimated: found.estimated,
        ...(openLength ? { marker: 'open' as const } : {}),
      };
    }
  }
  const { estimates } = context;
  const [percent, marker]: readonly [number, IntensityMarker] =
    effort.kind === 'free'
      ? [estimates.freeRide, 'free']
      : effort.kind === 'max-effort'
        ? [estimates.maxEffort, 'max-effort']
        : isHeartRateUnit(effort.primary.unit)
          ? [estimates.heartRate, 'heart-rate']
          : [estimates.other, 'other'];
  const value =
    context.basis === 'percent-ftp'
      ? percent
      : (percent * (context.referenceFtp ?? ASSUMED_FTP_WATTS)) / 100;
  return {
    start: range(value),
    end: range(value),
    ramp: false,
    power: false,
    estimated: true,
    marker,
  };
}

/** The middle of a range: where a range counts in the metrics and the chart. */
export const middle = (value: WorkoutRange) => (value.low + value.high) / 2;
