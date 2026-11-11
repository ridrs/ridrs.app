// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  Workout,
  WorkoutDuration,
  WorkoutEffort,
  WorkoutExtensions,
  WorkoutIntensity,
  WorkoutRepeat,
  WorkoutStep,
  WorkoutTarget,
} from '@ridrs/contracts';
import type { WorkoutImporter } from '../../codec.ts';
import {
  baseName,
  compact,
  type Diagnostics,
  decodeText,
  guarded,
  ImportError,
  parseNumber,
  sourceOf,
  workoutId,
} from './common.ts';
import { Attrs, Kids, parseXml, textOf, toJson, type XmlElement, type XmlJson } from './xml.ts';

/**
 * Garmin TCX workouts: `TrainingCenterDatabase/Workouts/Workout` with `Step` and `Repeat` steps
 * (`xsi:type` `Step_t` and `Repeat_t`), as defined by Garmin's TrainingCenterDatabase v2 schema
 * (https://www8.garmin.com/xmlschemas/TrainingCenterDatabasev2.xsd). The `xsi:type` names of
 * durations and targets, ids, unknown attributes and unknown children (`Extensions`, `Creator`,
 * `ScheduledOn` ...) are kept in `extensions.tcx`, together with the root's attributes (the
 * namespaces), so an export can write the file again.
 */

const localName = (name: string): string => name.slice(name.indexOf(':') + 1);

/** The `xsi:type` of an element, whatever the prefix; it is taken from the attributes. */
function typeOf(attrs: Attrs): string | undefined {
  const name = attrs.names.find((n) => localName(n) === 'type');
  if (name === undefined) return undefined;
  return attrs.take(name)?.trim();
}

interface Extras {
  attributes?: Record<string, string>;
  children?: { index: number; node: XmlJson }[];
}

const extras = (attrs: Attrs, kids: Kids): Extras | undefined => {
  const value = compact({ attributes: attrs.rest(), children: kids.rest() });
  return Object.keys(value).length === 0 ? undefined : value;
};

const childText = (element: XmlElement, name: string): string | undefined => {
  const child = element.children.find(
    (n): n is XmlElement => 'name' in n && localName(n.name) === name,
  );
  return child ? textOf(child) : undefined;
};

/** `<Low xsi:type="PowerInWatts_t"><Value>250</Value></Low>`: the number and the type. */
function measureOf(element: XmlElement): { value: number | undefined; type: string | undefined } {
  const type = Object.entries(element.attributes).find(([n]) => localName(n) === 'type')?.[1];
  const inner = childText(element, 'Value');
  return { value: parseNumber(inner ?? textOf(element)), type };
}

const INTENSITIES: Record<string, WorkoutIntensity> = {
  active: 'active',
  resting: 'rest',
  warmup: 'warm-up',
  cooldown: 'cool-down',
};

class Context {
  constructor(readonly diagnostics: Diagnostics) {}
}

function durationOf(
  element: XmlElement | undefined,
  place: string,
): { duration: WorkoutDuration; extension: Record<string, unknown> } {
  if (!element) {
    throw new ImportError('missing-element', `${place} has no Duration.`, place);
  }
  const attrs = new Attrs(element);
  const kids = new Kids(element);
  const type = typeOf(attrs);
  const need = (name: string): number => {
    const child = kids.takeFirst(name);
    const value = child ? parseNumber(textOf(child)) : undefined;
    if (value === undefined || value < 0) {
      throw new ImportError('bad-duration', `${place}: ${type} needs a number ${name}.`, place);
    }
    return value;
  };
  let duration: WorkoutDuration;
  let heartRateType: string | undefined;
  switch (type) {
    case 'Time_t':
      duration = { kind: 'time', seconds: need('Seconds') };
      break;
    case 'Distance_t':
      duration = { kind: 'distance', meters: need('Meters') };
      break;
    case 'CaloriesBurned_t':
      duration = { kind: 'energy', kilocalories: need('Calories') };
      break;
    case 'UserInput_t':
    case 'LapButton_t':
      duration = { kind: 'open' };
      break;
    case 'HeartRateAbove_t':
    case 'HeartRateBelow_t': {
      const rate = kids.takeFirst('HeartRate');
      const { value, type: rateType } = rate
        ? measureOf(rate)
        : { value: undefined, type: undefined };
      if (value === undefined) {
        throw new ImportError('bad-duration', `${place}: ${type} needs a HeartRate value.`, place);
      }
      heartRateType = rateType;
      duration = {
        kind: 'until',
        unit: rateType?.includes('Percent') ? 'percent-max-hr' : 'bpm',
        comparison: type === 'HeartRateAbove_t' ? 'above' : 'below',
        value,
      };
      break;
    }
    default:
      throw new ImportError(
        'bad-duration',
        `${place}: the duration type "${type ?? 'missing'}" is not known.`,
        place,
      );
  }
  return { duration, extension: compact({ type, heartRateType, ...extras(attrs, kids) }) };
}

function targetOf(
  element: XmlElement | undefined,
  place: string,
  context: Context,
): { effort: WorkoutEffort; extension?: Record<string, unknown> } {
  if (!element) return { effort: { kind: 'free' } };
  const attrs = new Attrs(element);
  const kids = new Kids(element);
  const type = typeOf(attrs);
  const keep = (
    effort: WorkoutEffort,
    extra: Record<string, unknown> = {},
  ): { effort: WorkoutEffort; extension: Record<string, unknown> } => ({
    effort,
    extension: compact({ type, ...extra, ...extras(attrs, kids) }),
  });
  const unmapped = (why: string) => {
    context.diagnostics.warn('unmapped-target', `${place}: ${why}; kept in the extensions.`, place);
    return {
      effort: { kind: 'free' } as WorkoutEffort,
      extension: { type, raw: toJson(element) },
    };
  };
  const zoneOf = (name: string) => {
    const zone = kids.takeFirst(name);
    if (!zone) return undefined;
    const zoneAttrs = new Attrs(zone);
    const zoneKids = new Kids(zone);
    const zoneType = typeOf(zoneAttrs);
    return { zone, zoneType, zoneAttrs, zoneKids };
  };
  const target = (unit: WorkoutTarget['unit'], low: number, high: number): WorkoutEffort => ({
    kind: 'target',
    primary: { unit, start: { low, high } },
  });

  switch (type) {
    case 'None_t':
      return keep({ kind: 'free' });
    case 'Power_t':
    case 'HeartRate_t': {
      const power = type === 'Power_t';
      const found = zoneOf(power ? 'PowerZone' : 'HeartRateZone');
      if (!found) return unmapped(`${type} has no zone`);
      const { zone, zoneType, zoneAttrs, zoneKids } = found;
      if (zoneType?.startsWith('Predefined')) {
        const number = parseNumber(childText(zone, 'Number'));
        if (number === undefined) return unmapped(`${zoneType} has no Number`);
        zoneKids.takeFirst('Number');
        return keep(target(power ? 'power-zone' : 'hr-zone', number, number), {
          zone: compact({ type: zoneType, ...extras(zoneAttrs, zoneKids) }),
        });
      }
      if (zoneType?.startsWith('Custom')) {
        const lowElement = zoneKids.takeFirst('Low');
        const highElement = zoneKids.takeFirst('High');
        const low = lowElement ? measureOf(lowElement) : undefined;
        const high = highElement ? measureOf(highElement) : undefined;
        if (low?.value === undefined || high?.value === undefined) {
          return unmapped(`${zoneType} has no Low and High`);
        }
        const typeName = low.type ?? '';
        const unit: WorkoutTarget['unit'] = power
          ? /percent/i.test(typeName)
            ? 'percent-ftp'
            : 'watts'
          : /percent/i.test(typeName)
            ? 'percent-max-hr'
            : 'bpm';
        return keep(target(unit, low.value, high.value), {
          zone: compact({
            type: zoneType,
            lowType: low.type,
            highType: high.type,
            ...extras(zoneAttrs, zoneKids),
          }),
        });
      }
      return unmapped(`the zone type "${zoneType ?? 'missing'}" is not known`);
    }
    case 'Cadence_t': {
      const low = parseNumber(childText(element, 'Low'));
      const high = parseNumber(childText(element, 'High'));
      if (low === undefined || high === undefined) return unmapped('Cadence_t has no Low and High');
      kids.takeFirst('Low');
      kids.takeFirst('High');
      return keep(target('rpm', low, high));
    }
    case 'Speed_t': {
      const found = zoneOf('SpeedZone');
      if (found?.zoneType === 'CustomSpeedZone_t') {
        const low = parseNumber(childText(found.zone, 'LowInMetersPerSecond'));
        const high = parseNumber(childText(found.zone, 'HighInMetersPerSecond'));
        if (low !== undefined && high !== undefined) {
          found.zoneKids.takeFirst('LowInMetersPerSecond');
          found.zoneKids.takeFirst('HighInMetersPerSecond');
          return keep(target('meters-per-second', low, high), {
            zone: compact({
              type: found.zoneType,
              ...extras(found.zoneAttrs, found.zoneKids),
            }),
          });
        }
      }
      // A predefined speed zone is a number of the device's own table: no unit to keep it in.
      return unmapped('a speed zone of the device has no unit in the workout format');
    }
    default:
      return unmapped(`the target type "${type ?? 'missing'}" is not known`);
  }
}

function stepOf(element: XmlElement, id: string, place: string, context: Context): WorkoutStep {
  const attrs = new Attrs(element);
  const kids = new Kids(element);
  const type = typeOf(attrs);
  const stepIdElement = kids.takeFirst('StepId');
  const stepId = stepIdElement ? textOf(stepIdElement) : undefined;
  const nameElement = kids.takeFirst('Name');
  const name = nameElement ? textOf(nameElement) : undefined;

  const isRepeat =
    type === 'Repeat_t' ||
    (type === undefined && kids.elements.some((e) => e.name === 'Repetitions'));
  if (isRepeat) {
    const repsElement = kids.takeFirst('Repetitions');
    const reps = repsElement ? parseNumber(textOf(repsElement)) : undefined;
    if (reps === undefined || !Number.isInteger(reps) || reps < 1) {
      throw new ImportError('bad-repetitions', `${place} has no valid Repetitions.`, place);
    }
    const children = kids
      .takeAll('Child')
      .map((child, i) => stepOf(child, `${id}.${i + 1}`, `${place}/Child[${i + 1}]`, context));
    const repeat: WorkoutRepeat = {
      kind: 'repeat',
      id,
      until: { kind: 'count', reps },
      steps: children,
      extensions: {
        tcx: compact({ type, stepId, name, ...extras(attrs, kids) }),
      },
    };
    return repeat;
  }
  if (type !== undefined && type !== 'Step_t') {
    throw new ImportError('bad-step', `${place}: the step type "${type}" is not known.`, place);
  }

  const { duration, extension: durationExtension } = durationOf(kids.takeFirst('Duration'), place);
  const intensityElement = kids.takeFirst('Intensity');
  const intensityText = intensityElement ? textOf(intensityElement) : undefined;
  const intensity =
    intensityText === undefined ? undefined : INTENSITIES[intensityText.toLowerCase()];
  if (intensityText !== undefined && intensity === undefined) {
    context.diagnostics.warn(
      'unknown-intensity',
      `${place}: the intensity "${intensityText}" is not known; kept in the extensions.`,
      place,
    );
  }
  const { effort, extension: targetExtension } = targetOf(kids.takeFirst('Target'), place, context);
  const notesElement = kids.takeFirst('Notes');
  const notes = notesElement ? textOf(notesElement) : undefined;

  const extensions: WorkoutExtensions = {
    tcx: compact({
      type,
      stepId,
      intensity: intensity === undefined ? intensityText : undefined,
      duration: durationExtension,
      target: targetExtension,
      ...extras(attrs, kids),
    }),
  };
  return {
    kind: 'interval',
    id,
    ...(name ? { name } : {}),
    ...(notes ? { notes } : {}),
    ...(intensity ? { intensity } : {}),
    duration,
    effort,
    extensions,
  };
}

export const importTcx: WorkoutImporter = (input, options = {}) =>
  guarded((diagnostics) => {
    const root = parseXml(decodeText(input));
    if (localName(root.name) !== 'TrainingCenterDatabase') {
      throw new ImportError(
        'not-tcx',
        `A TCX file starts with <TrainingCenterDatabase>, this one with <${root.name}>.`,
      );
    }
    const rootKids = new Kids(root);
    const workoutsElement = rootKids.takeFirst('Workouts');
    const workoutsAttrs = workoutsElement ? new Attrs(workoutsElement) : undefined;
    const workoutsKids = workoutsElement ? new Kids(workoutsElement) : undefined;
    const workoutElements = workoutsKids?.takeAll('Workout') ?? [];
    if (workoutElements.length === 0) {
      throw new ImportError('no-workout', 'The file has no <Workout> in <Workouts>.', 'Workouts');
    }
    const document = compact({
      attributes: { ...root.attributes },
      children: rootKids.rest(),
      workouts: workoutsAttrs && workoutsKids ? extras(workoutsAttrs, workoutsKids) : undefined,
    });

    const context = new Context(diagnostics);
    const workouts: Workout[] = [];
    const skipped: ImportError[] = [];
    workoutElements.forEach((element, w) => {
      const place = `Workouts/Workout[${w + 1}]`;
      const attrs = new Attrs(element);
      const kids = new Kids(element);
      const sport = attrs.take('Sport');
      if (sport !== undefined && sport.toLowerCase() !== 'biking') {
        skipped.push(
          new ImportError(
            'not-cycling',
            `${place} is a "${sport}" workout; only cycling (Sport="Biking") is imported.`,
            place,
          ),
        );
        return;
      }
      if (sport === undefined) {
        diagnostics.warn('missing-sport', `${place} has no Sport; it is read as cycling.`, place);
      }
      const nameElement = kids.takeFirst('Name');
      const notesElement = kids.takeFirst('Notes');
      const stepElements = kids.takeAll('Step');
      const steps = stepElements.map((step, i) =>
        stepOf(step, String(i + 1), `${place}/Step[${i + 1}]`, context),
      );
      const name =
        (nameElement ? textOf(nameElement) : '') ||
        baseName(options.fileName) ||
        'Untitled workout';
      if (!nameElement || textOf(nameElement) === '') {
        diagnostics.warn('missing-name', `${place} has no Name; "${name}" is used.`, place);
      }
      const notes = notesElement ? textOf(notesElement) : undefined;
      const id = workoutId(options, name);
      workouts.push({
        format: 'ridrs-workout',
        version: 1,
        id: workoutElements.length > 1 ? `${id}-${w + 1}` : id,
        name,
        ...(notes ? { description: notes } : {}),
        sport: 'ride',
        source: sourceOf('tcx', options),
        steps,
        extensions: {
          tcx: compact({
            attributes: attrs.rest(),
            children: kids.rest(),
            document,
            ...(workoutElements.length > 1 ? { workoutIndex: w } : {}),
          }),
        },
      });
    });
    const [first] = skipped;
    if (workouts.length === 0 && first) throw first;
    for (const error of skipped) {
      diagnostics.warn(error.code, `${error.message} It was skipped.`, error.at);
    }
    return workouts;
  });
