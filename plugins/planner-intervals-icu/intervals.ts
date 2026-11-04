// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  PlannedWorkout,
  TrainingAthlete,
  WorkoutInterval,
  WorkoutPower,
  WorkoutStep,
} from '@ridrs/contracts';

/**
 * From the intervals.icu API to the training contract (ADR 0048). The answers are untrusted:
 * every field is checked, and whatever does not fit is left out rather than failing the plan.
 * Field names follow the OpenAPI spec at https://intervals.icu/api/v1/docs; `workout_doc` is
 * untyped there and follows the shape the web app writes.
 */

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const positive = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;

const nonNegative = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined;

/** The cycling types ridrs plans for; a planned run or swim is not a ride on the trainer. */
const SPORTS: Readonly<Record<string, PlannedWorkout['sport']>> = {
  Ride: 'ride',
  VirtualRide: 'virtual-ride',
};

/** `GET /api/v1/athlete/0`: the name, the weight and the cycling sport settings. */
export function toAthlete(body: unknown): TrainingAthlete {
  const athlete = isObject(body) ? body : {};
  const settings = Array.isArray(athlete.sportSettings) ? athlete.sportSettings : [];
  const ride = settings.find(
    (entry): entry is Json =>
      isObject(entry) && Array.isArray(entry.types) && entry.types.includes('Ride'),
  );
  // ridrs rides indoors: an indoor FTP, where the athlete set one, is the one that applies.
  const ftp = positive(ride?.indoor_ftp) ?? positive(ride?.ftp);
  const weight = positive(athlete.icu_weight) ?? positive(athlete.weight);
  const lthr = positive(ride?.lthr);
  const maxHeartRate = positive(ride?.max_hr);
  return {
    name: text(athlete.name) ?? '',
    ...(ftp !== undefined ? { ftp } : {}),
    ...(weight !== undefined ? { weight } : {}),
    ...(lthr !== undefined ? { lthr } : {}),
    ...(maxHeartRate !== undefined ? { maxHeartRate } : {}),
  };
}

/** `GET /api/v1/athlete/0/events`: the planned cycling workouts, in date order. */
export function toWorkouts(body: unknown, ftp: number | undefined): PlannedWorkout[] {
  const events = Array.isArray(body) ? body.filter(isObject) : [];
  return events
    .filter((event) => event.category === 'WORKOUT' && typeof event.type === 'string')
    .flatMap((event): Array<PlannedWorkout & { start: string }> => {
      const sport = SPORTS[event.type as string];
      const start = typeof event.start_date_local === 'string' ? event.start_date_local : '';
      const date = start.slice(0, 10);
      if (!sport || !/^\d{4}-\d{2}-\d{2}$/.test(date) || event.id === undefined) {
        return [];
      }
      const description = text(event.description);
      const durationSeconds = nonNegative(event.moving_time);
      const trainingLoad = nonNegative(event.icu_training_load);
      const doc = isObject(event.workout_doc) ? event.workout_doc : undefined;
      return [
        {
          start,
          id: String(event.id),
          date,
          name: text(event.name) ?? 'Workout',
          sport,
          ...(description !== undefined ? { description } : {}),
          ...(durationSeconds !== undefined ? { durationSeconds } : {}),
          ...(trainingLoad !== undefined ? { trainingLoad } : {}),
          steps: toSteps(doc?.steps, ftp),
        },
      ];
    })
    .sort((a, b) => a.start.localeCompare(b.start))
    .map(({ start: _start, ...workout }) => workout);
}

/** The steps of a `workout_doc`, repeats nested. */
export function toSteps(steps: unknown, ftp: number | undefined): WorkoutStep[] {
  if (!Array.isArray(steps)) {
    return [];
  }
  return steps.filter(isObject).flatMap((step): WorkoutStep[] => {
    const reps = positive(step.reps);
    if (reps !== undefined && Array.isArray(step.steps)) {
      const inner = toSteps(step.steps, ftp);
      return inner.length > 0 ? [{ kind: 'repeat', reps: Math.round(reps), steps: inner }] : [];
    }
    const durationSeconds = nonNegative(step.duration);
    if (durationSeconds === undefined) {
      return [];
    }
    const power = toPower(step.power, ftp);
    const cadence = toRange(step.cadence);
    const label = text(step.text);
    const interval: WorkoutInterval = {
      kind: 'interval',
      durationSeconds,
      ...(step.warmup === true ? { phase: 'warm-up' as const } : {}),
      ...(step.cooldown === true ? { phase: 'cool-down' as const } : {}),
      ...(label !== undefined ? { text: label } : {}),
      ...(power ? { power } : {}),
      ...(cadence ? { cadence } : {}),
    };
    return [interval];
  });
}

/** `{ value }` or `{ start, end }` (a ramp); `undefined` for anything else. */
function toRange(target: unknown): { low: number; high: number } | undefined {
  if (!isObject(target)) {
    return undefined;
  }
  const value = nonNegative(target.value);
  if (value !== undefined) {
    return { low: value, high: value };
  }
  const start = nonNegative(target.start);
  const end = nonNegative(target.end);
  return start !== undefined && end !== undefined ? { low: start, high: end } : undefined;
}

/** In % FTP, and in watts when the FTP is known. Targets in watts need the FTP to convert. */
function toPower(target: unknown, ftp: number | undefined): WorkoutPower | undefined {
  const range = toRange(target);
  const units = isObject(target) ? target.units : undefined;
  if (!range) {
    return undefined;
  }
  let percent: { low: number; high: number };
  if (units === '%ftp') {
    percent = range;
  } else if (units === 'w' && ftp !== undefined) {
    percent = { low: (range.low / ftp) * 100, high: (range.high / ftp) * 100 };
  } else {
    // Zones, % of MMP and the like need data ridrs does not load.
    return undefined;
  }
  return {
    low: percent.low,
    high: percent.high,
    ...(ftp !== undefined
      ? {
          lowWatts: Math.round((percent.low * ftp) / 100),
          highWatts: Math.round((percent.high * ftp) / 100),
        }
      : {}),
  };
}

/** The rider's local date of an instant, `YYYY-MM-DD`. */
export function localDate(epochMs: number, addDays = 0): string {
  const at = new Date(epochMs);
  const day = new Date(at.getFullYear(), at.getMonth(), at.getDate() + addDays);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}
