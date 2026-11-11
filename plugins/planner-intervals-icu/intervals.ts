// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  AthleteProfile,
  CompletedWorkout,
  LibraryWorkout,
  PlannedWorkout,
  WorkoutInterval,
  WorkoutRange,
  WorkoutStep,
  WorkoutTarget,
  WorkoutTargetUnit,
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

/** The cycling settings of the athlete. */
const rideSettings = (athlete: Json): Json | undefined =>
  (Array.isArray(athlete.sportSettings) ? athlete.sportSettings : []).find(
    (entry): entry is Json =>
      isObject(entry) && Array.isArray(entry.types) && entry.types.includes('Ride'),
  );

/** The field of the Ride settings the FTP is read from, and written to: the indoor FTP, else the FTP. */
export function ftpField(body: unknown): 'indoor_ftp' | 'ftp' {
  const ride = rideSettings(isObject(body) ? body : {});
  return positive(ride?.indoor_ftp) !== undefined ? 'indoor_ftp' : 'ftp';
}

/**
 * `GET /api/v1/athlete/0`: the name, the weight and the cycling sport settings. The weight is
 * today's wellness weight (`GET …/wellness/{today}`), else the weight of the athlete.
 */
export function toAthlete(body: unknown, wellnessWeight?: number): AthleteProfile {
  const athlete = isObject(body) ? body : {};
  const ride = rideSettings(athlete);
  // ridrs rides indoors: an indoor FTP, where the athlete set one, is the one that applies.
  const ftp = positive(ride?.indoor_ftp) ?? positive(ride?.ftp);
  const weight =
    positive(wellnessWeight) ?? positive(athlete.icu_weight) ?? positive(athlete.weight);
  const lthr = positive(ride?.lthr);
  const maxHeartRate = positive(ride?.max_hr);
  const name = text(athlete.name);
  return {
    ...(name !== undefined ? { name } : {}),
    ...(ftp !== undefined ? { ftp: Math.round(ftp) } : {}),
    ...(weight !== undefined ? { weight } : {}),
    ...(lthr !== undefined ? { lthr } : {}),
    ...(maxHeartRate !== undefined ? { maxHeartRate } : {}),
  };
}

/** `GET /api/v1/athlete/0/events`: the planned cycling workouts, in date order. */
export function toWorkouts(body: unknown): PlannedWorkout[] {
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
          steps: toSteps(doc?.steps),
        },
      ];
    })
    .sort((a, b) => a.start.localeCompare(b.start))
    .map(({ start: _start, ...workout }) => workout);
}

/** `GET /api/v1/athlete/0/activities`: the cycling rides that were done, oldest first. */
export function toActivities(body: unknown): CompletedWorkout[] {
  return (Array.isArray(body) ? body.filter(isObject) : [])
    .flatMap((activity): CompletedWorkout[] => {
      const sport = typeof activity.type === 'string' ? SPORTS[activity.type] : undefined;
      const local = typeof activity.start_date_local === 'string' ? activity.start_date_local : '';
      const date = local.slice(0, 10);
      if (!sport || !/^\d{4}-\d{2}-\d{2}$/.test(date) || activity.id === undefined) {
        return [];
      }
      const utc = typeof activity.start_date === 'string' ? Date.parse(activity.start_date) : Number.NaN;
      const durationSeconds = nonNegative(activity.moving_time);
      const trainingLoad = nonNegative(activity.icu_training_load);
      const externalId = text(activity.external_id);
      return [
        {
          id: String(activity.id),
          date,
          ...(Number.isFinite(utc) ? { startedAt: utc } : {}),
          name: text(activity.name) ?? 'Ride',
          sport,
          ...(durationSeconds !== undefined ? { durationSeconds } : {}),
          ...(trainingLoad !== undefined ? { trainingLoad } : {}),
          ...(externalId !== undefined ? { externalId } : {}),
        },
      ];
    })
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.date.localeCompare(b.date));
}

/**
 * `GET /api/v1/athlete/0/workouts` with `GET …/folders`: the cycling workouts of the library,
 * each with the name of its folder or plan, ordered by folder and name.
 */
export function toLibrary(body: unknown, folders: unknown): LibraryWorkout[] {
  const names = new Map(
    (Array.isArray(folders) ? folders.filter(isObject) : []).flatMap((folder) => {
      const name = text(folder.name);
      return folder.id !== undefined && name !== undefined ? [[String(folder.id), name] as const] : [];
    }),
  );
  return (Array.isArray(body) ? body.filter(isObject) : [])
    .flatMap((entry): LibraryWorkout[] => {
      const sport = typeof entry.type === 'string' ? SPORTS[entry.type] : undefined;
      if (!sport || entry.id === undefined) {
        return [];
      }
      const folder = entry.folder_id == null ? undefined : names.get(String(entry.folder_id));
      const description = text(entry.description);
      const durationSeconds = nonNegative(entry.moving_time);
      const trainingLoad = nonNegative(entry.icu_training_load);
      const doc = isObject(entry.workout_doc) ? entry.workout_doc : undefined;
      return [
        {
          id: String(entry.id),
          name: text(entry.name) ?? 'Workout',
          ...(folder !== undefined ? { folder } : {}),
          sport,
          ...(description !== undefined ? { description } : {}),
          ...(durationSeconds !== undefined ? { durationSeconds } : {}),
          ...(trainingLoad !== undefined ? { trainingLoad } : {}),
          steps: toSteps(doc?.steps),
        },
      ];
    })
    .sort((a, b) => (a.folder ?? '').localeCompare(b.folder ?? '') || a.name.localeCompare(b.name));
}

/** The `workout_doc` of each workout of `GET /api/v1/athlete/0/workouts`, by the workout's id. */
export function libraryDocs(body: unknown): Record<string, unknown> {
  return Object.fromEntries(
    (Array.isArray(body) ? body.filter(isObject) : []).flatMap((entry) =>
      entry.id !== undefined && entry.workout_doc !== undefined
        ? [[String(entry.id), entry.workout_doc] as const]
        : [],
    ),
  );
}

/**
 * The steps of a `workout_doc`, repeats nested, in the canonical model (ADR 0081): targets keep
 * their unit, nothing is converted. Step ids are their path, `1`, `2`, `2.1`; the whole document
 * is read in the catalogue phase (structured-workouts.md, section 8).
 */
export function toSteps(steps: unknown, prefix = ''): WorkoutStep[] {
  if (!Array.isArray(steps)) {
    return [];
  }
  return steps.filter(isObject).flatMap((step, index): WorkoutStep[] => {
    const id = `${prefix}${index + 1}`;
    const reps = positive(step.reps);
    if (reps !== undefined && Array.isArray(step.steps)) {
      const inner = toSteps(step.steps, `${id}.`);
      return inner.length > 0
        ? [{ kind: 'repeat', id, until: { kind: 'count', reps: Math.round(reps) }, steps: inner }]
        : [];
    }
    const seconds = nonNegative(step.duration);
    if (seconds === undefined) {
      return [];
    }
    const ramp = step.ramp === true;
    const power = toTarget(step.power, POWER_UNITS, ramp);
    const cadence = toTarget(step.cadence, { rpm: 'rpm' }, ramp, 'rpm');
    const name = text(step.text);
    const interval: WorkoutInterval = {
      kind: 'interval',
      id,
      ...(name !== undefined ? { name } : {}),
      ...(step.warmup === true ? { intensity: 'warm-up' as const } : {}),
      ...(step.cooldown === true ? { intensity: 'cool-down' as const } : {}),
      duration: { kind: 'time', seconds },
      effort: power
        ? { kind: 'target', primary: power, ...(cadence ? { secondary: [cadence] } : {}) }
        : { kind: 'free', ...(cadence ? { secondary: [cadence] } : {}) },
    };
    return [interval];
  });
}

/** The power units of a `workout_doc`, as the canonical model names them. */
const POWER_UNITS: Readonly<Record<string, WorkoutTargetUnit>> = {
  '%ftp': 'percent-ftp',
  w: 'watts',
  power_zone: 'power-zone',
};

/** `{ value }` or `{ start, end }`; `undefined` for anything else. */
function toRange(target: Json): { start: WorkoutRange; end?: WorkoutRange } | undefined {
  const value = nonNegative(target.value);
  if (value !== undefined) {
    return { start: { low: value, high: value } };
  }
  const start = nonNegative(target.start);
  const end = nonNegative(target.end);
  return start !== undefined && end !== undefined
    ? { start: { low: start, high: start }, end: { low: end, high: end } }
    : undefined;
}

/**
 * A target in its own unit. `start` and `end` are a ramp when the step says `ramp`, else a range
 * ("stay between"). Units ridrs does not know yet (% of MMP and the like) give none.
 */
function toTarget(
  target: unknown,
  units: Readonly<Record<string, WorkoutTargetUnit>>,
  ramp: boolean,
  fallbackUnit?: WorkoutTargetUnit,
): WorkoutTarget | undefined {
  if (!isObject(target)) {
    return undefined;
  }
  const unit = typeof target.units === 'string' ? units[target.units] : fallbackUnit;
  const range = toRange(target);
  if (unit === undefined || range === undefined) {
    return undefined;
  }
  if (range.end === undefined) {
    return { unit, start: range.start };
  }
  return ramp
    ? { unit, start: range.start, end: range.end }
    : { unit, start: { low: range.start.low, high: range.end.low } };
}

/** The rider's local date of an instant, `YYYY-MM-DD`. */
export function localDate(epochMs: number, addDays = 0): string {
  const at = new Date(epochMs);
  const day = new Date(at.getFullYear(), at.getMonth(), at.getDate() + addDays);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}
