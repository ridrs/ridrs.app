// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Workout, WorkoutStep } from '@ridrs/contracts';
import {
  type IntensityEstimates,
  intensityContext,
  middle,
  type PowerBasis,
  segmentIntensity,
} from './intensity.ts';
import { isPowerUnit, resolveTarget, type WorkoutAthlete } from './resolve.ts';
import { type TimelineOptions, workoutTimeline } from './timeline.ts';
import { defaultPowerZones, zoneOf } from './zones.ts';

/**
 * The numbers of a workout, derived and never stored (ADR 0081):
 * - The power is sampled every second, at the middle of that second; a range counts at its
 *   middle, a ramp rises linearly, so the mean of a ramp's samples is its exact mean. A last
 *   partial second counts by its share.
 * - NP (normalised power) is the fourth root of the mean fourth power of the 30-second rolling
 *   average, from the 30th sample on (Coggan); a workout shorter than 30 s takes its mean.
 * - IF = NP / FTP; the training load (TSS) = s × NP × IF / (FTP × 3600) × 100 = h × IF² × 100.
 * - Work in kJ is the sum of the power over the seconds.
 * - Steps without a power target count at an assumed intensity (`IntensityEstimates`) and make
 *   the numbers estimated; so does any estimated length.
 * IF and the load need % FTP: a workout in watts needs an FTP for them. Watts, work and the time
 * per zone need the FTP of the athlete (the zones without one would be neutral, ADR 0082).
 */

export interface MetricsOptions extends TimelineOptions {
  readonly estimates?: Partial<IntensityEstimates>;
}

export interface WorkoutMetrics {
  readonly durationSeconds: number;
  /** A length is estimated (distance, energy, lap button, `until`, a repeat without a count). */
  readonly durationEstimated: boolean;
  /** Some power was assumed: a step without a power target, or zones of the default set. */
  readonly intensityEstimated: boolean;
  readonly basis: PowerBasis;
  readonly normalizedPowerPercent?: number;
  readonly normalizedPowerWatts?: number;
  readonly intensityFactor?: number;
  readonly trainingLoad?: number;
  readonly kilojoules?: number;
  /** s per power zone of the athlete (Coggan's without their own), Z1 first; needs the FTP. */
  readonly timeInZones?: readonly number[];
  /** s of steps without a power target: counted in the numbers, not in a zone. */
  readonly secondsWithoutPowerTarget: number;
  /** The interval steps ERG can ride: their power target resolves with this athlete. */
  readonly ergStepIds: readonly string[];
}

const ROLLING_SECONDS = 30;

export function workoutMetrics(
  workout: Workout,
  athlete: WorkoutAthlete = {},
  options: MetricsOptions = {},
): WorkoutMetrics {
  const timeline = workoutTimeline(workout, options);
  const context = intensityContext(workout, athlete, options.estimates);
  const total = timeline.durationSeconds;
  const ftp = athlete.ftp;
  const zones = ftp ? (athlete.powerZones ?? defaultPowerZones()) : undefined;
  const timeInZones = zones?.map(() => 0);

  // 1-second samples in the basis unit, each with its weight (1, a last partial second less).
  const samples: number[] = [];
  let weighted = 0;
  let withoutTarget = 0;
  let intensityEstimated = false;
  const count = Math.ceil(total);
  let index = 0;
  for (let second = 0; second < count; second++) {
    const weight = Math.min(1, total - second);
    const at = second + weight / 2;
    let segment = timeline.segments[index];
    while (segment && at >= segment.startSeconds + segment.durationSeconds) {
      segment = timeline.segments[++index];
    }
    if (!segment) break;
    const intensity = segmentIntensity(segment, context);
    const share = (at - segment.startSeconds) / segment.durationSeconds;
    const start = middle(intensity.start);
    const value = start + (middle(intensity.end) - start) * share;
    samples.push(value);
    weighted += value * weight;
    intensityEstimated ||= intensity.estimated;
    if (!intensity.power) withoutTarget += weight;
    else if (zones && timeInZones) {
      const percent = context.basis === 'percent-ftp' ? value : (value * 100) / (ftp ?? 1);
      const zone = zoneOf(percent, zones) - 1;
      timeInZones[zone] = (timeInZones[zone] ?? 0) + weight;
    }
  }

  const np = normalizedPower(samples);
  const watts = (value: number) =>
    context.basis === 'watts' ? value : ftp ? (value * ftp) / 100 : undefined;
  const intensityFactor =
    np !== undefined && context.basis === 'percent-ftp' ? np / 100 : undefined;
  const npWatts = np === undefined ? undefined : watts(np);
  const meanWatts = watts(weighted);

  return {
    durationSeconds: total,
    durationEstimated: timeline.estimated,
    intensityEstimated,
    basis: context.basis,
    ...(np !== undefined && context.basis === 'percent-ftp' ? { normalizedPowerPercent: np } : {}),
    ...(npWatts === undefined ? {} : { normalizedPowerWatts: npWatts }),
    ...(intensityFactor === undefined
      ? {}
      : { intensityFactor, trainingLoad: (total / 3600) * intensityFactor ** 2 * 100 }),
    ...(meanWatts === undefined ? {} : { kilojoules: meanWatts / 1000 }),
    ...(timeInZones ? { timeInZones } : {}),
    secondsWithoutPowerTarget: withoutTarget,
    ergStepIds: ergStepIds(workout.steps, athlete),
  };
}

/** NP of 1-second samples; undefined without samples. */
export function normalizedPower(samples: readonly number[]): number | undefined {
  if (samples.length === 0) return undefined;
  if (samples.length < ROLLING_SECONDS) {
    return samples.reduce((sum, value) => sum + value, 0) / samples.length;
  }
  let window = 0;
  let sum = 0;
  let averages = 0;
  samples.forEach((value, second) => {
    window += value - (second >= ROLLING_SECONDS ? (samples[second - ROLLING_SECONDS] ?? 0) : 0);
    if (second >= ROLLING_SECONDS - 1) {
      sum += (window / ROLLING_SECONDS) ** 4;
      averages++;
    }
  });
  return (sum / averages) ** 0.25;
}

/** The interval steps whose primary target is power and resolves: what ERG can hold. */
function ergStepIds(steps: readonly WorkoutStep[], athlete: WorkoutAthlete): string[] {
  return steps.flatMap((step) => {
    if (step.kind === 'repeat') return ergStepIds(step.steps, athlete);
    const { effort } = step;
    if (effort.kind !== 'target' || !isPowerUnit(effort.primary.unit)) return [];
    return resolveTarget(effort.primary, athlete).ok ? [step.id] : [];
  });
}
