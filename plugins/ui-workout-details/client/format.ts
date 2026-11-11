// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  WorkoutDuration,
  WorkoutEffort,
  WorkoutInterval,
  WorkoutRange,
  WorkoutRepeat,
  WorkoutTarget,
  WorkoutTargetUnit,
} from '@ridrs/contracts';
import {
  isHeartRateUnit,
  isPowerUnit,
  resolveTarget,
  type TrainingZones,
  type WorkoutAthlete,
  type WorkoutMetrics,
} from '@ridrs/workout';
import type { Messages } from './i18n/index.ts';

/**
 * How the details word a workout: targets in their own unit (no conversion, ADR 0081), with the
 * resolved watts or bpm beside them where the athlete profile allows it; estimated values marked
 * with "≈" (structured-workouts.md, sections 4.2, 6; F5).
 */

const EN_DASH = '–';
const APPROX = '≈ ';

/** "1 h 3 min", "2 h", "12 min", "16 min 30 s", "45 s", as the training plan writes them. */
export function durationText(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m > 0 ? `${h} h ${m} min` : `${h} h`;
  if (m > 0) return s > 0 ? `${m} min ${s} s` : `${m} min`;
  return `${s} s`;
}

/** A number in the language's notation with at most `digits` decimals ("0.81", "0,81"). */
export function decimal(value: number, text: Messages, digits = 1, fixed = false): string {
  return new Intl.NumberFormat(text.locale, {
    maximumFractionDigits: digits,
    minimumFractionDigits: fixed ? digits : 0,
    useGrouping: false,
  }).format(value);
}

/** "90", "85–95", "Z2", "Z2–Z3": one range of a unit, without the unit. */
function rangeText(range: WorkoutRange, unit: WorkoutTargetUnit, text: Messages): string {
  const one = (value: number) => (isZone(unit) ? `Z${value}` : decimal(value, text));
  return range.low === range.high ? one(range.low) : `${one(range.low)}${EN_DASH}${one(range.high)}`;
}

const isZone = (unit: WorkoutTargetUnit) => unit === 'power-zone' || unit === 'hr-zone';

/** Puts the unit around a number or range: "90 % FTP", "150 W", "Z2", "HR Z2", "RPE 6". */
function withUnit(value: string, unit: WorkoutTargetUnit, text: Messages): string {
  switch (unit) {
    case 'percent-ftp':
      return `${value} % FTP`;
    case 'watts':
      return `${value} W`;
    case 'power-zone':
      return value;
    case 'percent-lthr':
      return `${value} ${text.units.percentLthr}`;
    case 'percent-max-hr':
      return `${value} ${text.units.percentMaxHr}`;
    case 'bpm':
      return `${value} bpm`;
    case 'hr-zone':
      return `${text.units.heartRateZone} ${value}`;
    case 'rpm':
      return `${value} rpm`;
    case 'meters-per-second':
      return `${value} m/s`;
    case 'percent-threshold-speed':
      return `${value} ${text.units.percentThresholdSpeed}`;
    case 'rpe':
      return `${text.units.rpe} ${value}`;
  }
}

/** A target in its own unit: "90 % FTP", "50 → 75 % FTP" (a ramp), "130–140 bpm" (a range). */
export function ownTargetText(target: WorkoutTarget, text: Messages): string {
  const start = rangeText(target.start, target.unit, text);
  const value = target.end ? `${start} → ${rangeText(target.end, target.unit, text)}` : start;
  return withUnit(value, target.unit, text);
}

/** Units the profile turns into watts or bpm for showing beside them; watts and bpm stay alone. */
const RESOLVED_BESIDE: ReadonlySet<WorkoutTargetUnit> = new Set([
  'percent-ftp',
  'power-zone',
  'percent-lthr',
  'percent-max-hr',
  'hr-zone',
]);

/**
 * A target in its own unit, and beside it in watts or bpm when the athlete has the values for
 * it: "90 % FTP · 225 W". Without them, the own unit alone.
 */
export function targetText(target: WorkoutTarget, athlete: WorkoutAthlete, text: Messages): string {
  const own = ownTargetText(target, text);
  if (!RESOLVED_BESIDE.has(target.unit)) return own;
  const resolved = resolveTarget(target, athlete);
  return resolved.ok ? `${own} · ${ownTargetText(resolved.target, text)}` : own;
}

/** What a step asks: its target or free ride or max effort, then its secondary targets. */
export function effortText(effort: WorkoutEffort, athlete: WorkoutAthlete, text: Messages): string {
  const secondary = 'secondary' in effort ? (effort.secondary ?? []) : [];
  const main =
    effort.kind === 'target'
      ? targetText(effort.primary, athlete, text)
      : effort.kind === 'free'
        ? text.freeRide
        : text.maxEffort;
  return [main, ...secondary.map((target) => targetText(target, athlete, text))].join(' · ');
}

/** What a value of this unit measures, for "until heart rate below 110 bpm". */
function quantityOf(unit: WorkoutTargetUnit, text: Messages): string {
  if (isPowerUnit(unit)) return text.quantities.power;
  if (isHeartRateUnit(unit)) return text.quantities.heartRate;
  if (unit === 'rpm') return text.quantities.cadence;
  if (unit === 'rpe') return text.quantities.effort;
  return text.quantities.speed;
}

/** "until heart rate below 110 bpm" */
function conditionText(
  condition: { readonly unit: WorkoutTargetUnit; readonly comparison: 'above' | 'below'; readonly value: number },
  text: Messages,
): string {
  const value = withUnit(rangeText({ low: condition.value, high: condition.value }, condition.unit, text), condition.unit, text);
  return text.until(quantityOf(condition.unit, text), text[condition.comparison], value);
}

/** "5 km", "800 m" */
function distanceText(meters: number, text: Messages): string {
  return meters >= 1000 ? `${decimal(meters / 1000, text, 2)} km` : `${decimal(meters, text, 0)} m`;
}

/** How long a step lasts, as it states it: a time, a distance, an energy, a bound or the lap button. */
export function stepDurationText(duration: WorkoutDuration, text: Messages): string {
  switch (duration.kind) {
    case 'time':
      return durationText(duration.seconds);
    case 'distance':
      return distanceText(duration.meters, text);
    case 'energy':
      return `${decimal(duration.kilocalories, text, 0)} kcal`;
    case 'open':
      return text.untilLapButton;
    case 'until':
      return conditionText(duration, text);
  }
}

/** Why a step is marked (F5): it goes by heart rate, or does not end by time. */
export type StepMark = 'heart-rate' | 'distance' | 'energy' | 'until' | 'open';

export function stepMarks(step: WorkoutInterval): StepMark[] {
  const marks: StepMark[] = [];
  if (step.effort.kind === 'target' && isHeartRateUnit(step.effort.primary.unit)) {
    marks.push('heart-rate');
  }
  if (step.duration.kind !== 'time') marks.push(step.duration.kind);
  return marks;
}

/** The step's own name, else what its intensity calls it. */
export function stepName(step: WorkoutInterval, text: Messages): string {
  return step.name ?? (step.intensity ? text.intensities[step.intensity] : text.step);
}

/** "3×", "Repeat for 20 min", "Repeat until heart rate above 150 bpm". */
export function repeatText(repeat: WorkoutRepeat, text: Messages): string {
  const { until } = repeat;
  switch (until.kind) {
    case 'count':
      return `${until.reps}×`;
    case 'time':
      return text.repeatFor(durationText(until.seconds));
    case 'distance':
      return text.repeatFor(distanceText(until.meters, text));
    case 'energy':
      return text.repeatFor(`${decimal(until.kilocalories, text, 0)} kcal`);
    case 'condition':
      return text.repeatUntil(conditionText(until, text));
  }
}

/** Whether a number rests on assumptions: a length or an intensity was guessed. */
const estimated = (metrics: WorkoutMetrics) =>
  metrics.durationEstimated || metrics.intensityEstimated;

/** The numbers of the details, label and value, "–" where the profile lacks what one needs. */
export function numbersOf(metrics: WorkoutMetrics, text: Messages): [string, string][] {
  const mark = estimated(metrics) ? APPROX : '';
  const or = (value: number | undefined, show: (value: number) => string) =>
    value === undefined ? EN_DASH : `${mark}${show(value)}`;
  return [
    [text.duration, `${metrics.durationEstimated ? APPROX : ''}${durationText(metrics.durationSeconds)}`],
    [text.trainingLoad, or(metrics.trainingLoad, (load) => String(Math.round(load)))],
    [text.intensityFactor, or(metrics.intensityFactor, (factor) => decimal(factor, text, 2, true))],
    [text.work, or(metrics.kilojoules, (work) => `${Math.round(work)} kJ`)],
  ];
}

/**
 * The time per power zone, "Z3 Tempo" and "36 min" ("–" for none), and the time without a power
 * target when there is some. Undefined without an FTP: then there are no power zones (ADR 0082).
 */
export function zoneRowsOf(
  metrics: WorkoutMetrics,
  zones: TrainingZones,
  text: Messages,
): [string, string][] | undefined {
  if (!metrics.timeInZones) return undefined;
  const time = (seconds: number) => (seconds > 0 ? durationText(seconds) : EN_DASH);
  const rows: [string, string][] = zones.map((zone, index) => [
    zone.name ? `Z${index + 1} ${zone.name}` : `Z${index + 1}`,
    time(metrics.timeInZones?.[index] ?? 0),
  ]);
  if (metrics.secondsWithoutPowerTarget > 0) {
    rows.push([text.withoutPowerTarget, time(metrics.secondsWithoutPowerTarget)]);
  }
  return rows;
}

/** What stands in for the chart without its provider: "1 h 3 min · 69 TSS". */
export function chartFallbackText(metrics: WorkoutMetrics, text: Messages): string {
  const [, duration = ''] = numbersOf(metrics, text)[0] ?? [];
  const load = metrics.trainingLoad;
  const mark = estimated(metrics) ? APPROX : '';
  return text.chartFallback(duration, load === undefined ? undefined : `${mark}${Math.round(load)}`);
}

/** "Thu 12 Nov" for a local date `YYYY-MM-DD`, in the language's form. */
export function dayText(date: string, text: Messages): string {
  const [y = 0, m = 1, d = 1] = date.split('-').map(Number);
  const format = new Intl.DateTimeFormat(text.locale, { weekday: 'short', day: 'numeric', month: 'short' });
  return format.format(new Date(y, m - 1, d)).replace(',', '');
}
