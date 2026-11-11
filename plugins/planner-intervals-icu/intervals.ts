// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type AthleteProfile,
  type HeartRateZones,
  type PowerZones,
  powerZonesSchema,
} from '@ridrs/contracts';
import type {
  CompletedWorkout,
  LibraryWorkout,
  PlannedWorkout,
  WorkoutDuration,
  WorkoutEffort,
  WorkoutIntensity,
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
  const powerZones = toZones(ride?.power_zones, ride?.power_zone_names);
  const heartRateZones = toZones(ride?.hr_zones, ride?.hr_zone_names);
  return {
    ...(name !== undefined ? { name } : {}),
    ...(powerZones !== undefined ? { powerZones } : {}),
    ...(heartRateZones !== undefined ? { heartRateZones } : {}),
    ...(ftp !== undefined ? { ftp: Math.round(ftp) } : {}),
    ...(weight !== undefined ? { weight } : {}),
    ...(lthr !== undefined ? { lthr } : {}),
    ...(maxHeartRate !== undefined ? { maxHeartRate } : {}),
  };
}

/**
 * Zones of the Ride settings (ADR 0082): `power_zones` in % FTP and `hr_zones` in bpm are upper
 * bounds, lowest first, with their names beside them. The last zone is open in ridrs; intervals.icu
 * gives it a bound all the same (999 for power, the maximum heart rate for heart rate), which a
 * write puts back. Anything the profile's schema refuses gives no zones.
 */
function toZones(bounds: unknown, names: unknown): PowerZones | undefined {
  if (!Array.isArray(bounds) || bounds.length === 0) {
    return undefined;
  }
  const labels = Array.isArray(names) ? names : [];
  const zones = bounds.map((bound, index) => {
    const name = text(labels[index]);
    const upTo = index < bounds.length - 1 ? positive(bound) : undefined;
    return { ...(name !== undefined ? { name } : {}), ...(upTo !== undefined ? { upTo } : {}) };
  });
  const parsed = powerZonesSchema.safeParse(zones);
  return parsed.success ? parsed.data : undefined;
}

/** The bound intervals.icu keeps for the last, open heart rate zone. */
export function heartRateTop(body: unknown): number | undefined {
  const ride = rideSettings(isObject(body) ? body : {});
  return Array.isArray(ride?.hr_zones) ? positive(ride.hr_zones.at(-1)) : undefined;
}

/** The last, open power zone as intervals.icu writes it. */
const OPEN_POWER_ZONE = 999;

/**
 * The fields of `PUT sport-settings/Ride` for changed zones. Every zone gets a name (intervals.icu
 * keeps the names beside the bounds), `Z1`, `Z2`, … where ridrs has none.
 */
export function zoneSettings(
  change: { readonly powerZones?: PowerZones; readonly heartRateZones?: HeartRateZones },
  heartRateTopBound: number,
): Json {
  const names = (zones: PowerZones) => zones.map((zone, index) => zone.name ?? `Z${index + 1}`);
  const bounds = (zones: PowerZones, top: number) => zones.map((zone) => zone.upTo ?? top);
  return {
    ...(change.powerZones
      ? {
          power_zones: bounds(change.powerZones, OPEN_POWER_ZONE),
          power_zone_names: names(change.powerZones),
        }
      : {}),
    ...(change.heartRateZones
      ? {
          hr_zones: bounds(change.heartRateZones, heartRateTopBound),
          hr_zone_names: names(change.heartRateZones),
        }
      : {}),
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
 * their unit, nothing is converted, a range is not a ramp. Step ids are their path, `1`, `2`,
 * `2.1`. The shape follows the classes the developer of intervals.icu posted in "Downloading
 * planned workouts from the API" (https://forum.intervals.icu/t/downloading-planned-workouts-from-the-api/93737):
 * `text`, `duration`, `distance`, `until_lap_press`, `reps` and `steps`, `warmup`, `cooldown`,
 * `intensity`, `ramp`, `freeride`, `maxeffort`, and the values `power`, `hr`, `cadence`, each
 * `{ value }` or `{ start, end }` with `units`. What the model has no field for (`_power` and the
 * other resolved values, `hidepower`, `text_locale`, `pace`, a `%mmp` target, a value's `target`
 * or `mmp_duration`, the estimated `duration` of a distance step) stays in
 * `extensions.intervals.doc`, which `exportIntervalsDoc` restores. A step without any duration
 * is left out.
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
      const { reps: _reps, steps: _steps, ...rest } = step;
      return inner.length > 0
        ? [
            {
              kind: 'repeat',
              id,
              until: { kind: 'count', reps: Math.round(reps) },
              steps: inner,
              ...withDoc(rest, {}),
            },
          ]
        : [];
    }
    return toInterval(step, id);
  });
}

/** `extensions.intervals` of a step: what is `left` of it, and the marks of the reader. */
function withDoc(left: Json, marks: Json): { extensions?: { intervals: Json } } {
  const intervals = { ...(Object.keys(left).length > 0 ? { doc: left } : {}), ...marks };
  return Object.keys(intervals).length > 0 ? { extensions: { intervals } } : {};
}

const INTENSITIES: Readonly<Record<string, WorkoutIntensity>> = {
  warmup: 'warm-up',
  active: 'active',
  interval: 'interval',
  rest: 'rest',
  recovery: 'recovery',
  cooldown: 'cool-down',
  other: 'other',
};

function toInterval(step: Json, id: string): WorkoutInterval[] {
  const left: Json = { ...step };
  const take = <T>(key: string, found: T | undefined): T | undefined => {
    if (found !== undefined) {
      delete left[key];
    }
    return found;
  };

  let duration: WorkoutDuration | undefined;
  if (step.until_lap_press === true) {
    duration = take('until_lap_press', { kind: 'open' });
  } else if (nonNegative(step.distance) !== undefined) {
    duration = take('distance', { kind: 'distance', meters: step.distance as number });
  } else if (nonNegative(step.duration) !== undefined) {
    duration = take('duration', { kind: 'time', seconds: step.duration as number });
  }
  if (duration === undefined) {
    return [];
  }

  const name = take('text', text(step.text));
  const marks: Json = {};
  let intensity = take(
    'intensity',
    typeof step.intensity === 'string' ? INTENSITIES[step.intensity] : undefined,
  );
  if (intensity === 'warm-up' || intensity === 'cool-down') {
    marks.intensityAs = 'text';
  }
  if (intensity === undefined) {
    intensity =
      take('warmup', step.warmup === true ? ('warm-up' as const) : undefined) ??
      take('cooldown', step.cooldown === true ? ('cool-down' as const) : undefined);
  }

  const ramp = step.ramp === true;
  let ramped = false;
  /** A value in its unit, its other fields left in the document. */
  const target = (key: 'power' | 'hr' | 'cadence', units: Readonly<Record<string, WorkoutTargetUnit>>, fallback?: WorkoutTargetUnit) => {
    const found = toTarget(step[key], units, ramp, fallback);
    if (found === undefined) {
      return undefined;
    }
    const raw = step[key] as Json;
    const other: Json = { ...raw };
    delete other.units;
    if (nonNegative(raw.start) !== undefined && nonNegative(raw.end) !== undefined) {
      delete other.start;
      delete other.end;
    } else {
      delete other.value;
    }
    if (Object.keys(other).length > 0) {
      left[key] = other;
    } else {
      delete left[key];
    }
    ramped ||= found.end !== undefined;
    return found;
  };
  const power = target('power', POWER_UNITS);
  const hr = target('hr', HR_UNITS);
  const cadence = target('cadence', { rpm: 'rpm' }, 'rpm');
  if (ramped) {
    delete left.ramp;
  }

  let effort: WorkoutEffort;
  const secondary = (targets: Array<WorkoutTarget | undefined>) => {
    const present = targets.filter((entry): entry is WorkoutTarget => entry !== undefined);
    return present.length > 0 ? { secondary: present } : {};
  };
  if (step.maxeffort === true) {
    delete left.maxeffort;
    effort = { kind: 'max-effort' };
    // Targets beside an all-out effort stay as they were written.
    for (const key of ['power', 'hr', 'cadence'] as const) {
      if (step[key] !== undefined) {
        left[key] = step[key];
      }
    }
  } else if (step.freeride === true) {
    delete left.freeride;
    effort = { kind: 'free', ...secondary([power, hr, cadence]) };
  } else if (power ?? hr) {
    effort = {
      kind: 'target',
      primary: (power ?? hr) as WorkoutTarget,
      ...secondary(power ? [hr, cadence] : [cadence]),
    };
  } else {
    marks.implicitFree = true;
    effort = { kind: 'free', ...secondary([cadence]) };
  }

  return [
    {
      kind: 'interval',
      id,
      ...(name !== undefined ? { name } : {}),
      ...(intensity !== undefined ? { intensity } : {}),
      duration,
      effort,
      ...withDoc(left, marks),
    },
  ];
}

/** The power units of a `workout_doc`, as the canonical model names them. */
const POWER_UNITS: Readonly<Record<string, WorkoutTargetUnit>> = {
  '%ftp': 'percent-ftp',
  w: 'watts',
  power_zone: 'power-zone',
};

/** The heart rate units of a `workout_doc`. */
const HR_UNITS: Readonly<Record<string, WorkoutTargetUnit>> = {
  '%lthr': 'percent-lthr',
  '%hr': 'percent-max-hr',
  bpm: 'bpm',
  hr_zone: 'hr-zone',
};

/** `{ start, end }` or `{ value }`; `undefined` for anything else. */
function toRange(target: Json): { start: WorkoutRange; end?: WorkoutRange } | undefined {
  const start = nonNegative(target.start);
  const end = nonNegative(target.end);
  if (start !== undefined && end !== undefined) {
    return { start: { low: start, high: start }, end: { low: end, high: end } };
  }
  const value = nonNegative(target.value);
  return value !== undefined ? { start: { low: value, high: value } } : undefined;
}

/**
 * A target in its own unit. `start` and `end` are a ramp when the step says `ramp`, else a range
 * ("stay between"). Units ridrs has no unit for (% of MMP and the like) give none.
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
