// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  Workout,
  WorkoutDuration,
  WorkoutInterval,
  WorkoutRepeat,
  WorkoutRepeatUntil,
  WorkoutStep,
  WorkoutTarget,
} from '@ridrs/contracts';
import { ENUMS, encodeFitMessages, type FitWriteMessage, type FitWriteValue } from '@ridrs/fit';
import { durationOf } from '../../core/index.ts';
import { record } from './common.ts';
import {
  extensionOf,
  finishExport,
  Notes,
  placeOf,
  secondaryOf,
  stepRamps,
  type WorkoutExport,
  type WorkoutExportOptions,
} from './shared.ts';

/**
 * FIT workout files (`file_id.type = workout`) with ridrs' own encoder: `workout` (26) and
 * `workout_step` (27), the fields `importFit` reads. FIT holds every unit and range of the model,
 * so nothing needs an FTP; what it cannot hold is a ramp (a ramp is written as small steps), cues,
 * a flat road and an all-out step. An export of a FIT workout restores `extensions.fit`: the other
 * messages of the file, the fields the model has no place for and developer data.
 */

const D = ENUMS.wktStepDuration;
const T = ENUMS.wktStepTarget;
const WATTS_OFFSET = ENUMS.workoutPower.wattsOffset;
const BPM_OFFSET = ENUMS.workoutHr.bpmOffset;

const INTENSITY = {
  active: ENUMS.intensity.active,
  rest: ENUMS.intensity.rest,
  'warm-up': ENUMS.intensity.warmup,
  'cool-down': ENUMS.intensity.cooldown,
  recovery: ENUMS.intensity.recovery,
  interval: ENUMS.intensity.interval,
  other: ENUMS.intensity.other,
} as const;

type Values = Record<string, FitWriteValue>;

/** A raw FIT value of power or heart rate: % up to a bound, else the absolute value plus an offset. */
function powerValue(unit: string, value: number): number | undefined {
  if (unit === 'watts') return value + WATTS_OFFSET;
  if (unit === 'percent-ftp') return value <= WATTS_OFFSET ? value : undefined;
  return undefined;
}
function heartValue(unit: string, value: number): number | undefined {
  if (unit === 'bpm') return value + BPM_OFFSET;
  if (unit === 'percent-max-hr') return value <= BPM_OFFSET ? value : undefined;
  return undefined;
}

const POWER_AVERAGED = {
  '3s': T.power3s,
  '10s': T.power10s,
  '30s': T.power30s,
  lap: T.powerLap,
} as const;

interface Group {
  type: string;
  value: string;
  low: string;
  high: string;
}
const PRIMARY: Group = {
  type: 'targetType',
  value: 'targetValue',
  low: 'customTargetValueLow',
  high: 'customTargetValueHigh',
};
const SECONDARY: Group = {
  type: 'secondaryTargetType',
  value: 'secondaryTargetValue',
  low: 'secondaryCustomTargetValueLow',
  high: 'secondaryCustomTargetValueHigh',
};

class Context {
  readonly messages: FitWriteMessage[] = [];
  constructor(readonly notes: Notes) {}
}

/** The fields of one target, or `undefined` when FIT cannot hold its unit. */
function targetFields(
  target: WorkoutTarget,
  group: Group,
  context: Context,
  at: string,
  id: string,
): Values | undefined {
  const { unit, start } = target;
  const whole = (value: number): number => {
    const rounded = Math.round(value);
    if (rounded !== value) {
      context.notes.warn(
        'value-rounded',
        `${at}: FIT holds whole numbers; a target value is rounded.`,
        id,
      );
    }
    return rounded;
  };
  const range = (
    type: number,
    low: number | undefined,
    high: number | undefined,
  ): Values | undefined => {
    if (low === undefined || high === undefined) {
      context.notes.warn(
        'target-dropped',
        `${at}: a target of ${start.low}–${start.high} ${unit} does not fit FIT's limits; it is not written.`,
        id,
      );
      return undefined;
    }
    return { [group.type]: type, [group.value]: 0, [group.low]: low, [group.high]: high };
  };
  const zone = (type: number): Values => {
    if (start.low !== start.high) {
      context.notes.warn('zone-range', `${at}: FIT holds one zone; the lowest is written.`, id);
    }
    return { [group.type]: type, [group.value]: Math.max(1, Math.round(start.low)) };
  };
  switch (unit) {
    case 'power-zone':
      return zone(T.power);
    case 'hr-zone':
      return zone(T.heartRate);
    case 'watts':
    case 'percent-ftp':
      return range(
        target.averaging ? POWER_AVERAGED[target.averaging] : T.power,
        powerValue(unit, whole(start.low)),
        powerValue(unit, whole(start.high)),
      );
    case 'bpm':
    case 'percent-max-hr':
      return range(
        target.averaging === 'lap' ? T.heartRateLap : T.heartRate,
        heartValue(unit, whole(start.low)),
        heartValue(unit, whole(start.high)),
      );
    case 'rpm':
      return range(T.cadence, whole(start.low), whole(start.high));
    case 'meters-per-second':
      return range(
        target.averaging === 'lap' ? T.speedLap : T.speed,
        Math.round(start.low * 1000),
        Math.round(start.high * 1000),
      );
    default:
      context.notes.warn(
        'target-dropped',
        `${at}: a target in ${unit} cannot be written in FIT; the step has an open target.`,
        id,
      );
      return undefined;
  }
}

const OPEN_TARGET = (group: Group): Values => ({ [group.type]: T.open });

/** Extension fields of a message by name; the groups the model computes are left to it. */
function leftovers(
  extension: Record<string, unknown> | undefined,
  skip: ReadonlySet<string>,
): Values {
  const out: Values = {};
  for (const [name, value] of Object.entries(record(extension?.fields) ?? {})) {
    if (skip.has(name)) continue;
    if (typeof value === 'number' || typeof value === 'string') out[name] = value;
    else if (Array.isArray(value) && value.every((b) => typeof b === 'number')) out[name] = value;
  }
  return out;
}

function developerOf(
  extension: Record<string, unknown> | undefined,
): FitWriteMessage['developerFields'] {
  const list = Array.isArray(extension?.developerFields) ? extension.developerFields : [];
  return list.flatMap((entry) => {
    const item = record(entry);
    if (!item || typeof item.bytes !== 'string' || typeof item.num !== 'number') return [];
    const bytes = new Uint8Array(
      (item.bytes.match(/../g) ?? []).map((pair) => Number.parseInt(pair, 16)),
    );
    return [{ developerDataIndex: Number(item.developerDataIndex ?? 0), num: item.num, bytes }];
  });
}

const GROUP_NAMES = new Set([
  'durationType',
  'durationValue',
  ...Object.values(PRIMARY),
  ...Object.values(SECONDARY),
  'messageIndex',
  'wktStepName',
  'notes',
  'intensity',
]);

function durationFields(
  step: WorkoutInterval,
  extension: Record<string, unknown> | undefined,
  context: Context,
): Values {
  const { duration } = step;
  const stated = record(extension?.fields)?.durationType;
  const until = duration.kind === 'until' ? duration : undefined;
  const heart = until && (until.unit === 'bpm' || until.unit === 'percent-max-hr');
  const watts = until && (until.unit === 'watts' || until.unit === 'percent-ftp');
  const value = until
    ? heart
      ? heartValue(until.unit, until.value)
      : powerValue(until.unit, until.value)
    : undefined;
  if (duration.kind === 'time') {
    const type = stated === D.repetitionTime || stated === D.timeOnly ? stated : D.time;
    return { durationType: type, durationValue: Math.round(duration.seconds * 1000) };
  }
  if (duration.kind === 'distance')
    return { durationType: D.distance, durationValue: Math.round(duration.meters * 100) };
  if (duration.kind === 'energy')
    return { durationType: D.calories, durationValue: Math.round(duration.kilocalories) };
  if (duration.kind === 'open') {
    const kept = record(extension?.fields)?.durationValue;
    return { durationType: D.open, ...(typeof kept === 'number' ? { durationValue: kept } : {}) };
  }
  if (until && (heart || watts) && value !== undefined) {
    const below = until.comparison === 'below';
    const averaged: number[] = below
      ? [D.power3sLessThan, D.power10sLessThan, D.power30sLessThan, D.powerLapLessThan]
      : [D.power3sGreaterThan, D.power10sGreaterThan, D.power30sGreaterThan, D.powerLapGreaterThan];
    const type = heart
      ? below
        ? D.hrLessThan
        : D.hrGreaterThan
      : typeof stated === 'number' && averaged.includes(stated)
        ? stated
        : below
          ? D.powerLessThan
          : D.powerGreaterThan;
    return { durationType: type, durationValue: value };
  }
  const { seconds } = durationOf(duration);
  context.notes.warn(
    'duration-estimated',
    `${placeOf(step)}: a bound in ${(duration as Extract<WorkoutDuration, { kind: 'until' }>).unit} cannot be written in FIT; it becomes a time step of ${Math.round(seconds)} s, estimated.`,
    step.id,
  );
  return { durationType: D.time, durationValue: Math.round(seconds * 1000) };
}

function intervalMessage(step: WorkoutInterval, index: number, context: Context): FitWriteMessage {
  const extension = extensionOf(step, 'fit');
  const at = placeOf(step);
  const stated = record(extension?.fields);
  const values: Values = { messageIndex: index };
  if (step.name !== undefined) values.wktStepName = step.name;
  Object.assign(values, durationFields(step, extension, context));
  if (step.intensity !== undefined) values.intensity = INTENSITY[step.intensity];
  if (step.notes !== undefined) values.notes = step.notes;

  const targets = step.effort.kind === 'target' ? [step.effort.primary] : [];
  const secondary = secondaryOf(step);
  const primary = targets[0] ? targetFields(targets[0], PRIMARY, context, at, step.id) : undefined;
  if (step.effort.kind === 'max-effort') {
    context.notes.warn(
      'max-effort-open',
      `${at}: FIT has no all-out step; it has an open target.`,
      step.id,
    );
  }
  if (step.effort.kind === 'free' && step.effort.flatRoad !== undefined) {
    context.notes.warn(
      'flat-road-dropped',
      `${at}: FIT does not hold "flat road" for a free ride.`,
      step.id,
    );
  }
  if (primary) {
    Object.assign(values, primary);
  } else if (step.effort.kind === 'free' && stated?.targetType !== undefined) {
    // An unsupported target the importer kept: written back as it was.
    for (const name of Object.values(PRIMARY)) {
      const kept = stated[name];
      if (typeof kept === 'number') values[name] = kept;
    }
  } else {
    Object.assign(values, OPEN_TARGET(PRIMARY));
  }
  let second: Values | undefined;
  for (const target of secondary) {
    second = targetFields(target, SECONDARY, context, at, step.id);
    if (second) break;
  }
  if (secondary.length > 1) {
    context.notes.warn(
      'secondary-dropped',
      `${at}: FIT holds one second target per step; the others are not written.`,
      step.id,
    );
  }
  if (second) {
    Object.assign(values, second);
  } else if (secondary.length === 0 && stated?.secondaryTargetType !== undefined) {
    for (const name of Object.values(SECONDARY)) {
      const kept = stated[name];
      if (typeof kept === 'number') values[name] = kept;
    }
  }
  if (step.cues?.length) {
    context.notes.warn('cues-dropped', 'FIT has no texts during a step; they are not written.');
  }
  Object.assign(values, { ...leftovers(extension, GROUP_NAMES), ...values });
  const developerFields = developerOf(extension);
  return {
    message: 'workoutStep',
    values,
    ...(developerFields?.length ? { developerFields } : {}),
  };
}

/** How a repeat ends as FIT writes it, or `undefined` for a bound it cannot hold. */
function repeatFields(
  until: WorkoutRepeatUntil,
  extension: Record<string, unknown> | undefined,
): { type: number; value: number } | undefined {
  switch (until.kind) {
    case 'count':
      return { type: D.repeatUntilStepsCmplt, value: until.reps };
    case 'time':
      return { type: D.repeatUntilTime, value: Math.round(until.seconds * 1000) };
    case 'distance':
      return { type: D.repeatUntilDistance, value: Math.round(until.meters * 100) };
    case 'energy':
      return { type: D.repeatUntilCalories, value: Math.round(until.kilocalories) };
    case 'condition': {
      const below = until.comparison === 'below';
      const hr = heartValue(until.unit, until.value);
      if (hr !== undefined) {
        return { type: below ? D.repeatUntilHrLessThan : D.repeatUntilHrGreaterThan, value: hr };
      }
      const power = powerValue(until.unit, until.value);
      if (power === undefined) return undefined;
      const stated = record(extension?.fields)?.durationType;
      const lastLap =
        below &&
        (stated === D.repeatUntilPowerLastLapLessThan ||
          stated === D.repeatUntilMaxPowerLastLapLessThan);
      return {
        type: lastLap
          ? (stated as number)
          : below
            ? D.repeatUntilPowerLessThan
            : D.repeatUntilPowerGreaterThan,
        value: power,
      };
    }
  }
}

function walk(steps: readonly WorkoutStep[], context: Context): void {
  for (const step of steps) {
    if (step.kind === 'interval') {
      context.messages.push(intervalMessage(step, context.messages.length, context));
      continue;
    }
    writeRepeat(step, context);
  }
}

function writeRepeat(step: WorkoutRepeat, context: Context): void {
  if (step.steps.length === 0) return;
  const extension = extensionOf(step, 'fit');
  const ends = repeatFields(step.until, extension);
  if (!ends) {
    context.notes.warn(
      'repeat-until-once',
      `${placeOf(step)}: this bound of a repeat cannot be written in FIT; the steps are written once.`,
      step.id,
    );
    walk(step.steps, context);
    return;
  }
  const from = context.messages.length;
  walk(step.steps, context);
  if (context.messages.length === from) return;
  const values: Values = {
    messageIndex: context.messages.length,
    durationType: ends.type,
    durationValue: from,
    targetValue: ends.value,
  };
  Object.assign(values, { ...leftovers(extension, GROUP_NAMES), ...values });
  const developerFields = developerOf(extension);
  context.messages.push({
    message: 'workoutStep',
    values,
    ...(developerFields?.length ? { developerFields } : {}),
  });
}

/** The profile name of a sub sport ("indoor_cycling") as `ENUMS.subSport` has it. */
function subSportValue(name: string | undefined): number | undefined {
  if (!name) return undefined;
  const camel = name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  return (ENUMS.subSport as Record<string, number>)[camel];
}

export function exportFit(
  workout: Workout,
  _options: WorkoutExportOptions = {},
): WorkoutExport<Uint8Array> {
  const notes = new Notes();
  const context = new Context(notes);
  walk(stepRamps(workout.steps, notes, 'fit'), context);
  const steps = context.messages;
  if (workout.referenceFtp || workout.focus || workout.declared) {
    notes.warn(
      'metadata-dropped',
      'FIT has no place for the reference FTP, focus and declared values.',
    );
  }

  return finishExport('fit', notes, () => {
    const extension = extensionOf(workout, 'fit');
    const others: FitWriteMessage[] = [];
    for (const entry of Array.isArray(extension?.messages) ? extension.messages : []) {
      const item = record(entry);
      if (!item || typeof item.num !== 'number') continue;
      const values: Values = {};
      for (const [name, value] of Object.entries(record(item.fields) ?? {})) {
        if (typeof value === 'number' || typeof value === 'string') values[name] = value;
        else if (Array.isArray(value) && value.every((b) => typeof b === 'number'))
          values[name] = value;
      }
      const developerFields = developerOf(item);
      others.push({
        message: item.num,
        values,
        ...(developerFields?.length ? { developerFields } : {}),
      });
    }
    const fileId = others.find((m) => m.message === 0);
    if (fileId) {
      (fileId.values as Values).type = ENUMS.file.workout;
    } else {
      others.unshift({
        message: 'fileId',
        values: {
          type: ENUMS.file.workout,
          manufacturer: ENUMS.manufacturer.development,
          product: 0,
        },
      });
    }
    const subSport =
      subSportValue(workout.subSport) ??
      (workout.sport === 'virtual-ride' ? ENUMS.subSport.virtualActivity : undefined);
    const workoutValues: Values = {
      ...leftovers(
        { fields: record(extension)?.workout },
        new Set(['sport', 'subSport', 'wktName', 'wktDescription', 'numValidSteps']),
      ),
      sport: ENUMS.sport.cycling,
      subSport,
      wktName: workout.name,
      wktDescription: workout.description,
      numValidSteps: steps.length,
    };
    const developerFields = developerOf(extension);
    return encodeFitMessages([
      ...others,
      {
        message: 'workout',
        values: workoutValues,
        ...(developerFields?.length ? { developerFields } : {}),
      },
      ...steps,
    ]);
  });
}
