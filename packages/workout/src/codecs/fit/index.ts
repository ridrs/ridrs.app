// SPDX-License-Identifier: AGPL-3.0-or-later

// The FIT workout importer (ADR 0084, structured-workouts.md section 4.3): `workout` (26) and
// `workout_step` (27) of a `file_id.type = workout` file, read with ridrs' own decoder, become the
// canonical model. Nothing is converted: % FTP stays % FTP, watts stay watts. What the model has
// no field for goes to `extensions.fit`, so that a FIT export can write it again.
import {
  type Workout,
  type WorkoutDuration,
  type WorkoutEffort,
  type WorkoutIntensity,
  type WorkoutRepeatUntil,
  type WorkoutStep,
  type WorkoutTarget,
  type WorkoutTargetUnit,
  workoutSchema,
} from '@ridrs/contracts';
import { type DecodedFitMessage, decodeFit, ENUMS, type FitValue } from '@ridrs/fit';
import type { WorkoutDiagnostic, WorkoutImporter, WorkoutImportResult } from '../../codec.ts';

const MESG = { fileId: 0, workout: 26, workoutStep: 27 } as const;
const D = ENUMS.wktStepDuration;
const T = ENUMS.wktStepTarget;
const WATTS_OFFSET = ENUMS.workoutPower.wattsOffset;
const BPM_OFFSET = ENUMS.workoutHr.bpmOffset;

/** Field numbers of `workout` (26). */
const W = { sport: 4, wktName: 8, subSport: 11, wktDescription: 17 } as const;
/** Field numbers of `workout_step` (27). */
const S = {
  wktStepName: 0,
  durationType: 1,
  durationValue: 2,
  targetType: 3,
  targetValue: 4,
  customLow: 5,
  customHigh: 6,
  intensity: 7,
  notes: 8,
  secondaryTargetType: 19,
  secondaryTargetValue: 20,
  secondaryCustomLow: 21,
  secondaryCustomHigh: 22,
  messageIndex: 254,
} as const;

const INTENSITIES: Readonly<Record<number, WorkoutIntensity>> = {
  [ENUMS.intensity.active]: 'active',
  [ENUMS.intensity.rest]: 'rest',
  [ENUMS.intensity.warmup]: 'warm-up',
  [ENUMS.intensity.cooldown]: 'cool-down',
  [ENUMS.intensity.recovery]: 'recovery',
  [ENUMS.intensity.interval]: 'interval',
  [ENUMS.intensity.other]: 'other',
};

/** Profile names of the cycling sub sports, snake_case as the profile writes them. */
const SUB_SPORTS = new Map<number, string>(
  Object.entries(ENUMS.subSport).map(([name, value]) => [
    value,
    name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
  ]),
);

class Refused extends Error {
  constructor(readonly diagnostic: WorkoutDiagnostic) {
    super(diagnostic.message);
  }
}

function refuse(code: string, message: string, at?: string): never {
  throw new Refused({ severity: 'error', code, message, ...(at ? { at } : {}) });
}

/** FIT values as JSON: a 64-bit integer as its decimal string. */
function json(value: FitValue): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map((element) => (typeof element === 'bigint' ? element.toString() : element));
  }
  return value;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A message's fields, except those in `used`, by profile name or by number. */
function rest(message: DecodedFitMessage, used: ReadonlySet<number>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const field of Object.values(message.fields)) {
    if (!used.has(field.num)) {
      fields[field.name ?? String(field.num)] = json(field.value);
    }
  }
  return fields;
}

function developerFields(message: DecodedFitMessage) {
  return message.developerFields.map((field) => ({
    developerDataIndex: field.developerDataIndex,
    num: field.num,
    bytes: hex(field.bytes),
  }));
}

/** `{ fields?, developerFields? }` of what the model has no place for, or nothing. */
function leftovers(
  message: DecodedFitMessage,
  used: ReadonlySet<number>,
): Record<string, unknown> | undefined {
  const fields = rest(message, used);
  const developer = developerFields(message);
  const result = {
    ...(Object.keys(fields).length > 0 ? { fields } : {}),
    ...(developer.length > 0 ? { developerFields: developer } : {}),
  };
  return Object.keys(result).length > 0 ? result : undefined;
}

function number(message: DecodedFitMessage, num: number): number | undefined {
  const value = message.fields[num]?.value;
  return typeof value === 'number' ? value : undefined;
}

function text(message: DecodedFitMessage, num: number): string | undefined {
  const value = message.fields[num]?.value;
  return typeof value === 'string' ? value : undefined;
}

/** `workoutPower`: up to 1000 % FTP, above it watts + 1000. */
function power(value: number): { unit: WorkoutTargetUnit; value: number } {
  return value > WATTS_OFFSET
    ? { unit: 'watts', value: value - WATTS_OFFSET }
    : { unit: 'percent-ftp', value };
}

/** `workoutHr`: up to 100 % of the maximum heart rate, above it bpm + 100. */
function heartRate(value: number): { unit: WorkoutTargetUnit; value: number } {
  return value > BPM_OFFSET
    ? { unit: 'bpm', value: value - BPM_OFFSET }
    : { unit: 'percent-max-hr', value };
}

type Quantity = 'speed' | 'heart-rate' | 'cadence' | 'power';

const TARGETS: Readonly<
  Record<number, { quantity: Quantity; averaging?: WorkoutTarget['averaging'] }>
> = {
  [T.speed]: { quantity: 'speed' },
  [T.speedLap]: { quantity: 'speed', averaging: 'lap' },
  [T.heartRate]: { quantity: 'heart-rate' },
  [T.heartRateLap]: { quantity: 'heart-rate', averaging: 'lap' },
  [T.cadence]: { quantity: 'cadence' },
  [T.power]: { quantity: 'power' },
  [T.power3s]: { quantity: 'power', averaging: '3s' },
  [T.power10s]: { quantity: 'power', averaging: '10s' },
  [T.power30s]: { quantity: 'power', averaging: '30s' },
  [T.powerLap]: { quantity: 'power', averaging: 'lap' },
};

/** A custom value of a quantity in the unit the file states, never converted. */
function customValue(quantity: Quantity, raw: number): { unit: WorkoutTargetUnit; value: number } {
  switch (quantity) {
    case 'speed':
      return { unit: 'meters-per-second', value: raw / 1000 };
    case 'heart-rate':
      return heartRate(raw);
    case 'cadence':
      return { unit: 'rpm', value: raw };
    case 'power':
      return power(raw);
  }
}

const ZONE_UNITS: Partial<Record<Quantity, WorkoutTargetUnit>> = {
  'heart-rate': 'hr-zone',
  power: 'power-zone',
};

interface TargetFields {
  readonly type: number;
  readonly value: number;
  readonly low: number;
  readonly high: number;
}

/**
 * A primary or secondary target. `undefined` is "open"; a target the model cannot hold (a speed or
 * cadence zone, grade, resistance) is `unsupported`, its fields stay in the extensions.
 */
function target(
  message: DecodedFitMessage,
  nums: TargetFields,
  used: Set<number>,
  at: string,
  diagnostics: WorkoutDiagnostic[],
): WorkoutTarget | 'unsupported' | undefined {
  const type = number(message, nums.type);
  if (type === undefined || type === T.open) {
    if (type !== undefined) {
      used.add(nums.type);
    }
    return undefined;
  }
  const kind = TARGETS[type];
  const zone = number(message, nums.value);
  const low = number(message, nums.low);
  const high = number(message, nums.high);
  const averaging = kind?.averaging ? { averaging: kind.averaging } : {};
  if (kind && zone !== undefined && zone > 0) {
    const unit = ZONE_UNITS[kind.quantity];
    if (unit) {
      used.add(nums.type).add(nums.value);
      return { unit, start: { low: zone, high: zone }, ...averaging };
    }
  } else if (kind && (low !== undefined || high !== undefined)) {
    // A custom low and high are a range to stay in, not a ramp.
    const from = customValue(kind.quantity, low ?? (high as number));
    const to = customValue(kind.quantity, high ?? (low as number));
    if (from.unit !== to.unit) {
      refuse(
        'mixed-target-units',
        `The target's low (${low}) and high (${high}) are in different units.`,
        at,
      );
    }
    if (low === undefined || high === undefined) {
      diagnostics.push({
        severity: 'warning',
        code: 'one-sided-target',
        message: 'The target has only one bound; it is read as an exact value.',
        at,
      });
    }
    used.add(nums.type).add(nums.low).add(nums.high);
    if (zone === 0) {
      used.add(nums.value);
    }
    return { unit: from.unit, start: { low: from.value, high: to.value }, ...averaging };
  }
  diagnostics.push({
    severity: 'warning',
    code: 'unsupported-target',
    message: `Target type ${type} with this value has no place in the model; the step is a free ride and the FIT fields are kept.`,
    at,
  });
  return 'unsupported';
}

function duration(message: DecodedFitMessage, used: Set<number>, at: string): WorkoutDuration {
  const type = number(message, S.durationType) as number;
  const value = number(message, S.durationValue);
  used.add(S.durationType);
  if (type === D.open) {
    return { kind: 'open' };
  }
  if (value === undefined) {
    refuse('missing-duration-value', `Duration type ${type} needs a duration value.`, at);
  }
  used.add(S.durationValue);
  // Kinds the model tells apart only by a field it lacks keep their FIT type in the extensions.
  const keepType = () => used.delete(S.durationType);
  switch (type) {
    case D.time:
      return { kind: 'time', seconds: value / 1000 };
    case D.repetitionTime:
    case D.timeOnly:
      keepType();
      return { kind: 'time', seconds: value / 1000 };
    case D.distance:
      return { kind: 'distance', meters: value / 100 };
    case D.calories:
      return { kind: 'energy', kilocalories: value };
    case D.hrLessThan:
    case D.hrGreaterThan:
      return {
        kind: 'until',
        ...heartRate(value),
        comparison: type === D.hrLessThan ? 'below' : 'above',
      };
    case D.powerLessThan:
    case D.powerGreaterThan:
      return {
        kind: 'until',
        ...power(value),
        comparison: type === D.powerLessThan ? 'below' : 'above',
      };
    case D.power3sLessThan:
    case D.power10sLessThan:
    case D.power30sLessThan:
    case D.powerLapLessThan:
      keepType();
      return { kind: 'until', ...power(value), comparison: 'below' };
    case D.power3sGreaterThan:
    case D.power10sGreaterThan:
    case D.power30sGreaterThan:
    case D.powerLapGreaterThan:
      keepType();
      return { kind: 'until', ...power(value), comparison: 'above' };
    default:
      return refuse('unsupported-duration', `Duration type ${type} has no place in the model.`, at);
  }
}

const REPEAT_TYPES: ReadonlySet<number> = new Set([
  D.repeatUntilStepsCmplt,
  D.repeatUntilTime,
  D.repeatUntilDistance,
  D.repeatUntilCalories,
  D.repeatUntilHrLessThan,
  D.repeatUntilHrGreaterThan,
  D.repeatUntilPowerLessThan,
  D.repeatUntilPowerGreaterThan,
  D.repeatUntilPowerLastLapLessThan,
  D.repeatUntilMaxPowerLastLapLessThan,
  D.repeatUntilTrainingPeaksTss,
]);

/** How a `repeat_until_*` step ends its repeat: `target_value` holds the count or the bound. */
function repeatUntil(
  message: DecodedFitMessage,
  used: Set<number>,
  at: string,
): WorkoutRepeatUntil {
  const type = number(message, S.durationType) as number;
  const value = number(message, S.targetValue);
  if (value === undefined) {
    refuse('missing-repeat-value', `Repeat type ${type} needs a target value.`, at);
  }
  used.add(S.durationType).add(S.durationValue).add(S.targetValue);
  switch (type) {
    case D.repeatUntilStepsCmplt:
      if (!Number.isInteger(value) || value < 1) {
        refuse('bad-repeat', `A repeat of ${value} times is not possible.`, at);
      }
      return { kind: 'count', reps: value };
    case D.repeatUntilTime:
      return { kind: 'time', seconds: value / 1000 };
    case D.repeatUntilDistance:
      return { kind: 'distance', meters: value / 100 };
    case D.repeatUntilCalories:
      return { kind: 'energy', kilocalories: value };
    case D.repeatUntilHrLessThan:
    case D.repeatUntilHrGreaterThan:
      return {
        kind: 'condition',
        ...heartRate(value),
        comparison: type === D.repeatUntilHrLessThan ? 'below' : 'above',
      };
    case D.repeatUntilPowerLessThan:
    case D.repeatUntilPowerGreaterThan:
      return {
        kind: 'condition',
        ...power(value),
        comparison: type === D.repeatUntilPowerLessThan ? 'below' : 'above',
      };
    case D.repeatUntilPowerLastLapLessThan:
    case D.repeatUntilMaxPowerLastLapLessThan:
      used.delete(S.durationType);
      return { kind: 'condition', ...power(value), comparison: 'below' };
    default:
      return refuse('unsupported-repeat', `Repeat type ${type} has no place in the model.`, at);
  }
}

function withFit(extension: Record<string, unknown> | undefined) {
  return extension ? { extensions: { fit: extension } } : {};
}

function interval(
  message: DecodedFitMessage,
  id: string,
  at: string,
  diagnostics: WorkoutDiagnostic[],
): WorkoutStep {
  const used = new Set<number>([S.messageIndex]);
  const name = text(message, S.wktStepName);
  const notes = text(message, S.notes);
  const intensityValue = number(message, S.intensity);
  const intensity = intensityValue === undefined ? undefined : INTENSITIES[intensityValue];
  if (name !== undefined) used.add(S.wktStepName);
  if (notes !== undefined) used.add(S.notes);
  if (intensity !== undefined) used.add(S.intensity);
  const stepDuration = duration(message, used, at);
  const primary = target(
    message,
    { type: S.targetType, value: S.targetValue, low: S.customLow, high: S.customHigh },
    used,
    at,
    diagnostics,
  );
  const secondaryTarget = target(
    message,
    {
      type: S.secondaryTargetType,
      value: S.secondaryTargetValue,
      low: S.secondaryCustomLow,
      high: S.secondaryCustomHigh,
    },
    used,
    at,
    diagnostics,
  );
  const secondary =
    secondaryTarget && secondaryTarget !== 'unsupported' ? { secondary: [secondaryTarget] } : {};
  const effort: WorkoutEffort =
    primary && primary !== 'unsupported'
      ? { kind: 'target', primary, ...secondary }
      : { kind: 'free', ...secondary };
  return {
    kind: 'interval',
    id,
    ...(name !== undefined ? { name } : {}),
    ...(notes !== undefined ? { notes } : {}),
    ...(intensity !== undefined ? { intensity } : {}),
    duration: stepDuration,
    effort,
    ...withFit(leftovers(message, used)),
  };
}

interface Placed {
  /** The step index the node starts at: a repeat jumps back to it. */
  readonly first: number;
  readonly node: WorkoutStep;
}

/** Steps in file order; `repeat_until_*` steps jump back to an index and close a repeat. */
function steps(messages: readonly DecodedFitMessage[], diagnostics: WorkoutDiagnostic[]) {
  const indices = messages.map((message, position) => number(message, S.messageIndex) ?? position);
  if (new Set(indices).size !== indices.length) {
    refuse('bad-step-index', 'Two workout steps have the same message index.');
  }
  const placed: Placed[] = [];
  messages.forEach((message, position) => {
    const index = indices[position] as number;
    const at = `workout_step[${index}]`;
    const type = number(message, S.durationType);
    if (type === undefined) {
      refuse('missing-duration-type', 'The step has no duration type.', at);
    }
    if (!REPEAT_TYPES.has(type)) {
      placed.push({ first: index, node: interval(message, String(index), at, diagnostics) });
      return;
    }
    const used = new Set<number>([S.messageIndex]);
    const until = repeatUntil(message, used, at);
    const from = number(message, S.durationValue);
    const body: Placed[] = [];
    while (from !== undefined && placed.length > 0 && (placed.at(-1) as Placed).first >= from) {
      body.unshift(placed.pop() as Placed);
    }
    if (from === undefined || body[0]?.first !== from) {
      refuse(
        'bad-repeat',
        `The repeat jumps back to step ${from}, which does not start a step before it.`,
        at,
      );
    }
    placed.push({
      first: from,
      node: {
        kind: 'repeat',
        id: String(index),
        until,
        steps: body.map((entry) => entry.node),
        ...withFit(leftovers(message, used)),
      },
    });
  });
  return placed.map((entry) => entry.node);
}

/** "Sweet Spot 3x12.fit" -> "sweet-spot-3x12". */
function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function baseName(fileName: string): string {
  return (fileName.split(/[\\/]/).at(-1) ?? fileName).replace(/\.[^.]*$/, '');
}

function fieldsByName(message: DecodedFitMessage) {
  return {
    num: message.num,
    fields: rest(message, new Set()),
    ...(message.developerFields.length > 0 ? { developerFields: developerFields(message) } : {}),
  };
}

function importBytes(
  bytes: Uint8Array,
  options: Parameters<WorkoutImporter>[1] = {},
): WorkoutImportResult {
  const decoded = decodeFit(bytes);
  if (!decoded.ok) {
    return {
      ok: false,
      diagnostics: decoded.diagnostics.map((d) => ({
        severity: d.severity,
        code: d.code,
        message: d.message,
        ...(d.offset === undefined ? {} : { at: `byte ${d.offset}` }),
      })),
    };
  }
  const diagnostics: WorkoutDiagnostic[] = decoded.diagnostics.map((d) => ({
    severity: d.severity,
    code: d.code,
    message: d.message,
  }));
  const fileId = decoded.messages.find((message) => message.num === MESG.fileId);
  const fileType = fileId ? number(fileId, 0) : undefined;
  if (fileType !== ENUMS.file.workout) {
    refuse(
      'not-a-workout',
      fileType === ENUMS.file.activity
        ? 'The FIT file is an activity, not a workout.'
        : `The FIT file is of type ${fileType ?? 'unknown'}, not a workout.`,
      'file_id',
    );
  }
  const workouts = decoded.messages.filter((message) => message.num === MESG.workout);
  const workout = workouts[0];
  if (workout === undefined) {
    refuse('no-workout', 'The FIT workout file has no workout message.');
  }
  if (workouts.length > 1) {
    diagnostics.push({
      severity: 'warning',
      code: 'several-workouts',
      message: `The file has ${workouts.length} workout messages; the first is read.`,
    });
  }
  const sport = number(workout, W.sport);
  if (sport !== undefined && sport !== ENUMS.sport.cycling) {
    refuse('not-cycling', `The workout is for sport ${sport}, not cycling.`, 'workout');
  }
  if (sport === undefined) {
    diagnostics.push({
      severity: 'warning',
      code: 'no-sport',
      message: 'The workout names no sport; it is read as a cycling workout.',
      at: 'workout',
    });
  }
  const used = new Set<number>([W.sport]);
  const wktName = text(workout, W.wktName);
  const description = text(workout, W.wktDescription);
  const subSportValue = number(workout, W.subSport);
  const subSport = subSportValue === undefined ? undefined : SUB_SPORTS.get(subSportValue);
  if (wktName !== undefined) used.add(W.wktName);
  if (description !== undefined) used.add(W.wktDescription);
  if (subSport !== undefined) used.add(W.subSport);
  const name = wktName ?? (options.fileName ? baseName(options.fileName) : 'FIT workout');
  const workoutSteps = steps(
    decoded.messages.filter((message) => message.num === MESG.workoutStep),
    diagnostics,
  );

  const others = decoded.messages.filter(
    (message) => message !== workout && message.num !== MESG.workoutStep,
  );
  const workoutRest = leftovers(workout, used);
  const fit = {
    ...(workoutRest?.fields ? { workout: workoutRest.fields } : {}),
    ...(workoutRest?.developerFields ? { developerFields: workoutRest.developerFields } : {}),
    // file_id and every other message (file_creator, developer data ids, field descriptions …)
    // in file order, for an export to FIT.
    messages: others.map(fieldsByName),
  };
  const result: Workout = {
    format: 'ridrs-workout',
    version: 1,
    id:
      options.id ??
      (slug(options.fileName ? baseName(options.fileName) : '') || slug(name) || 'fit-workout'),
    name,
    ...(description !== undefined ? { description } : {}),
    sport: subSportValue === ENUMS.subSport.virtualActivity ? 'virtual-ride' : 'ride',
    ...(subSport !== undefined ? { subSport } : {}),
    source: {
      kind: options.sourceKind ?? 'imported',
      format: 'fit',
      ...(options.fileName !== undefined ? { fileName: options.fileName } : {}),
      ...(options.originalHash !== undefined ? { originalHash: options.originalHash } : {}),
      ...(options.importedAt !== undefined ? { importedAt: options.importedAt } : {}),
    },
    steps: workoutSteps,
    extensions: { fit },
  };
  const checked = workoutSchema.safeParse(result);
  if (!checked.success) {
    refuse('invalid-workout', `The imported workout is not valid: ${checked.error.message}`);
  }
  return { ok: true, workouts: [result], diagnostics };
}

/** Imports a FIT workout file (`file_id.type = workout`); other files are refused. */
export const importFit: WorkoutImporter = (input, options) => {
  if (typeof input === 'string') {
    return {
      ok: false,
      diagnostics: [
        { severity: 'error', code: 'not-fit', message: 'A FIT file is binary, not text.' },
      ],
    };
  }
  try {
    return importBytes(input, options);
  } catch (error) {
    if (error instanceof Refused) {
      return { ok: false, diagnostics: [error.diagnostic] };
    }
    throw error;
  }
};
