// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  Workout,
  WorkoutCue,
  WorkoutDuration,
  WorkoutEffort,
  WorkoutExtensions,
  WorkoutIntensity,
  WorkoutInterval,
  WorkoutStep,
  WorkoutTarget,
} from '@ridrs/contracts';
import type { WorkoutImporter } from '../../codec.ts';
import {
  baseName,
  compact,
  type Diagnostics,
  decodeText,
  fractionToPercent,
  guarded,
  ImportError,
  parseNumber,
  sourceOf,
  workoutId,
} from './common.ts';
import { Attrs, Kids, parseXml, textOf, toJson, type XmlElement, type XmlJson } from './xml.ts';

/**
 * Zwift workout files (ZWO), as the format is used in the wild: `workout_file` with the metadata
 * elements and a `workout` of steps (Zwift's own workout editor writes the same elements).
 * Power is a fraction of FTP in the file and a percentage here (0.75 becomes 75 `percent-ftp`).
 * Whatever has no field of the typed model goes to `extensions.zwo`: the spelling and attribute
 * order of each element, its unknown attributes and children, and what the metadata elements carry
 * beyond their text.
 */

/** The `extensions.zwo` of a step. */
interface ZwoStepExtension {
  /** The element as written, e.g. `IntervalsT`. */
  element: string;
  attributeOrder: string[];
  attributes?: Record<string, string>;
  children?: { index: number; node: XmlJson }[];
  /** What a `textevent` carries beyond its offset, message and duration, by its place. */
  textevents?: { index: number; attributes?: Record<string, string>; node?: XmlJson }[];
}

const ext = (value: ZwoStepExtension): WorkoutExtensions => ({ zwo: compact({ ...value }) });

class Context {
  constructor(
    readonly diagnostics: Diagnostics,
    /** `durationType`: whether `Duration` is seconds (default) or meters. */
    readonly distance: boolean,
  ) {}
}

const at = (element: XmlElement, index: number): string => `workout/${element.name}[${index + 1}]`;

function numberAttr(attrs: Attrs, name: string, place: string): number {
  const text = attrs.take(name);
  if (text === undefined) {
    throw new ImportError('missing-attribute', `${place} has no ${name}.`, place);
  }
  const value = parseNumber(text);
  if (value === undefined || value < 0) {
    throw new ImportError('bad-number', `${place}: ${name}="${text}" is not a number.`, place);
  }
  return value;
}

function powerAttr(attrs: Attrs, name: string, place: string): number {
  const text = attrs.take(name);
  if (text === undefined) {
    throw new ImportError('missing-attribute', `${place} has no ${name}.`, place);
  }
  const value = fractionToPercent(text);
  if (value === undefined || value < 0) {
    throw new ImportError('bad-number', `${place}: ${name}="${text}" is not a power.`, place);
  }
  return value;
}

const exact = (unit: WorkoutTarget['unit'], value: number): WorkoutTarget => ({
  unit,
  start: { low: value, high: value },
});

const durationOf = (seconds: number, context: Context): WorkoutDuration =>
  context.distance ? { kind: 'distance', meters: seconds } : { kind: 'time', seconds };

/** Cadence as secondary targets: `Cadence` is exact, `CadenceLow` with `CadenceHigh` a range. */
function cadenceTargets(
  attrs: Attrs,
  names: { exact: string; low?: string; high?: string },
  place: string,
  context: Context,
): WorkoutTarget[] {
  const cadence = (text: string, name: string): number | undefined => {
    const value = parseNumber(text);
    if (value === undefined || value < 0) {
      context.diagnostics.warn(
        'bad-cadence',
        `${place}: ${name}="${text}" is not a cadence.`,
        place,
      );
    }
    return value;
  };
  const targets: WorkoutTarget[] = [];
  const single = attrs.peek(names.exact);
  if (single !== undefined) {
    const value = cadence(single, names.exact);
    if (value !== undefined) {
      attrs.take(names.exact);
      targets.push(exact('rpm', value));
    }
  }
  if (names.low && names.high) {
    const low = attrs.peek(names.low);
    const high = attrs.peek(names.high);
    if (low !== undefined && high !== undefined) {
      const l = cadence(low, names.low);
      const h = cadence(high, names.high);
      if (l !== undefined && h !== undefined) {
        attrs.take(names.low);
        attrs.take(names.high);
        targets.push({ unit: 'rpm', start: { low: l, high: h } });
      }
    } else if (low !== undefined || high !== undefined) {
      context.diagnostics.warn(
        'unpaired-cadence-range',
        `${place} has only one of ${names.low} and ${names.high}; kept in the extensions.`,
        place,
      );
    }
  }
  return targets;
}

const withSecondary = (effort: WorkoutEffort, secondary: WorkoutTarget[]): WorkoutEffort => {
  if (secondary.length === 0 || effort.kind === 'max-effort') return effort;
  return { ...effort, secondary };
};

/** The `textevent` children of a step as cues; what they carry beyond that is returned. */
function cuesOf(
  kids: Kids,
  context: Context,
  place: string,
): { cues: WorkoutCue[]; extras: NonNullable<ZwoStepExtension['textevents']> } {
  const cues: WorkoutCue[] = [];
  const extras: NonNullable<ZwoStepExtension['textevents']> = [];
  for (const event of kids.takeAll('textevent')) {
    const attrs = new Attrs(event);
    const offset = parseNumber(attrs.peek('timeoffset'));
    const message = attrs.peek('message');
    if (offset === undefined || offset < 0 || message === undefined) {
      context.diagnostics.warn(
        'bad-textevent',
        `${place}: a textevent without a valid timeoffset and message is kept in the extensions.`,
        place,
      );
      extras.push({ index: cues.length + extras.length, node: toJson(event) });
      continue;
    }
    attrs.take('timeoffset');
    attrs.take('message');
    const durationText = attrs.peek('duration');
    const duration = parseNumber(durationText);
    if (duration !== undefined && duration >= 0) attrs.take('duration');
    cues.push({
      offsetSeconds: offset,
      ...(duration !== undefined && duration >= 0 ? { durationSeconds: duration } : {}),
      text: message,
    });
    const rest = attrs.rest();
    const children = new Kids(event).rest();
    if (rest || children) {
      extras.push({
        index: cues.length - 1,
        ...(rest ? { attributes: rest } : {}),
        ...(children ? { node: { name: event.name, children: children.map((c) => c.node) } } : {}),
      });
    }
  }
  return { cues, extras };
}

/** One step of the `workout`, by the element's name. */
function stepOf(element: XmlElement, index: number, id: string, context: Context): WorkoutStep {
  const place = at(element, index);
  const attrs = new Attrs(element);
  const kids = new Kids(element);
  const kind = element.name.toLowerCase();

  const finishInterval = (
    duration: WorkoutDuration,
    effort: WorkoutEffort,
    intensity?: WorkoutIntensity,
  ): WorkoutInterval => {
    const { cues, extras } = cuesOf(kids, context, place);
    return {
      kind: 'interval',
      id,
      ...(intensity ? { intensity } : {}),
      duration,
      effort,
      ...(cues.length > 0 ? { cues } : {}),
      extensions: ext({
        element: element.name,
        attributeOrder: attrs.names,
        attributes: attrs.rest(),
        children: kids.rest(),
        textevents: extras.length > 0 ? extras : undefined,
      } as ZwoStepExtension),
    };
  };

  switch (kind) {
    case 'steadystate':
    case 'solidstate': {
      const duration = durationOf(numberAttr(attrs, 'Duration', place), context);
      const power = powerAttr(attrs, 'Power', place);
      const effort = withSecondary(
        { kind: 'target', primary: exact('percent-ftp', power) },
        cadenceTargets(
          attrs,
          { exact: 'Cadence', low: 'CadenceLow', high: 'CadenceHigh' },
          place,
          context,
        ),
      );
      return finishInterval(duration, effort);
    }
    case 'ramp':
    case 'warmup':
    case 'cooldown': {
      const duration = durationOf(numberAttr(attrs, 'Duration', place), context);
      const low = powerAttr(attrs, 'PowerLow', place);
      const high = powerAttr(attrs, 'PowerHigh', place);
      const effort = withSecondary(
        {
          kind: 'target',
          primary: { unit: 'percent-ftp', start: { low, high: low }, end: { low: high, high } },
        },
        cadenceTargets(
          attrs,
          { exact: 'Cadence', low: 'CadenceLow', high: 'CadenceHigh' },
          place,
          context,
        ),
      );
      const intensity =
        kind === 'warmup' ? 'warm-up' : kind === 'cooldown' ? 'cool-down' : undefined;
      return finishInterval(duration, effort, intensity);
    }
    case 'freeride': {
      const duration = durationOf(numberAttr(attrs, 'Duration', place), context);
      const flat = attrs.peek('FlatRoad');
      const flatRoad =
        flat === '1' || flat?.toLowerCase() === 'true'
          ? true
          : flat === '0' || flat?.toLowerCase() === 'false'
            ? false
            : undefined;
      if (flatRoad !== undefined) attrs.take('FlatRoad');
      const effort = withSecondary(
        { kind: 'free', ...(flatRoad === undefined ? {} : { flatRoad }) },
        cadenceTargets(
          attrs,
          { exact: 'Cadence', low: 'CadenceLow', high: 'CadenceHigh' },
          place,
          context,
        ),
      );
      return finishInterval(duration, effort);
    }
    case 'maxeffort': {
      const duration = durationOf(numberAttr(attrs, 'Duration', place), context);
      return finishInterval(duration, { kind: 'max-effort' });
    }
    case 'intervalst': {
      const reps = numberAttr(attrs, 'Repeat', place);
      if (!Number.isInteger(reps) || reps < 1) {
        throw new ImportError('bad-number', `${place}: Repeat="${reps}" is not a count.`, place);
      }
      const on = durationOf(numberAttr(attrs, 'OnDuration', place), context);
      const off = durationOf(numberAttr(attrs, 'OffDuration', place), context);
      const onPower = powerAttr(attrs, 'OnPower', place);
      const offPower = powerAttr(attrs, 'OffPower', place);
      const onCadence = cadenceTargets(
        attrs,
        { exact: 'Cadence', low: 'CadenceLow', high: 'CadenceHigh' },
        place,
        context,
      );
      const offCadence = cadenceTargets(attrs, { exact: 'CadenceResting' }, place, context);
      // A cue offset counts from the start of the whole element, so it cannot belong to one of
      // the two repeated steps: it stays with the repeat.
      const { cues, extras } = cuesOf(kids, context, place);
      if (cues.length > 0) {
        context.diagnostics.info(
          'cues-kept-in-extensions',
          `${place}: textevents of an IntervalsT count from its start and are kept in its extensions.`,
          place,
        );
        extras.push(
          ...cues.map((cue, i) => ({
            index: i,
            attributes: {
              timeoffset: String(cue.offsetSeconds),
              message: cue.text,
              ...(cue.durationSeconds === undefined
                ? {}
                : { duration: String(cue.durationSeconds) }),
            },
          })),
        );
      }
      return {
        kind: 'repeat',
        id,
        until: { kind: 'count', reps },
        steps: [
          {
            kind: 'interval',
            id: `${id}.1`,
            intensity: 'interval',
            duration: on,
            effort: withSecondary(
              { kind: 'target', primary: exact('percent-ftp', onPower) },
              onCadence,
            ),
          },
          {
            kind: 'interval',
            id: `${id}.2`,
            intensity: 'recovery',
            duration: off,
            effort: withSecondary(
              { kind: 'target', primary: exact('percent-ftp', offPower) },
              offCadence,
            ),
          },
        ],
        extensions: ext({
          element: element.name,
          attributeOrder: attrs.names,
          attributes: attrs.rest(),
          children: kids.rest(),
          textevents: extras.length > 0 ? extras : undefined,
        } as ZwoStepExtension),
      };
    }
    default:
      throw new ImportError('internal', `Unexpected element ${element.name}.`, place);
  }
}

const STEP_ELEMENTS = new Set([
  'steadystate',
  'solidstate',
  'ramp',
  'warmup',
  'cooldown',
  'freeride',
  'maxeffort',
  'intervalst',
]);

export const importZwo: WorkoutImporter = (input, options = {}) =>
  guarded((diagnostics) => {
    const root = parseXml(decodeText(input));
    if (root.name !== 'workout_file') {
      throw new ImportError(
        'not-zwo',
        `A ZWO file starts with <workout_file>, this one with <${root.name}>.`,
      );
    }
    const rootAttrs = new Attrs(root);
    const kids = new Kids(root);
    const fieldExtras: Record<string, unknown> = {};

    /** The text of a metadata element; what it carries beyond its text is kept. */
    const field = (name: string): string | undefined => {
      const element = kids.takeFirst(name);
      if (!element) return undefined;
      const attrs = new Attrs(element).rest();
      const children = new Kids(element).rest();
      if (attrs || children) fieldExtras[name] = compact({ attributes: attrs, children });
      return textOf(element);
    };

    const author = field('author');
    const nameText = field('name');
    const description = field('description');
    const sportType = field('sportType');
    const durationType = field('durationType');
    const category = field('category');
    const subcategory = field('subcategory');

    if (sportType !== undefined && sportType.toLowerCase() !== 'bike') {
      throw new ImportError(
        'not-cycling',
        `The workout is for "${sportType}"; only cycling workouts (sportType bike) are imported.`,
        'workout_file/sportType',
      );
    }

    const tags: string[] = [];
    let tagsExtension: Record<string, unknown> | undefined;
    const tagsElement = kids.takeFirst('tags');
    if (tagsElement) {
      const tagsAttrs = new Attrs(tagsElement);
      const tagKids = new Kids(tagsElement);
      const tagExtras: { index: number; attributes?: Record<string, string>; node?: XmlJson }[] =
        [];
      tagKids.takeAll('tag').forEach((tag, index) => {
        const attrs = new Attrs(tag);
        const tagName = attrs.take('name');
        const rest = attrs.rest();
        const children = new Kids(tag).rest();
        if (tagName === undefined) {
          diagnostics.warn('bad-tag', 'A tag without a name is kept in the extensions.', 'tags');
          tagExtras.push({ index, node: toJson(tag) });
          return;
        }
        tags.push(tagName);
        if (rest || children) {
          tagExtras.push({
            index,
            ...(rest ? { attributes: rest } : {}),
            ...(children
              ? { node: { name: tag.name, children: children.map((c) => c.node) } }
              : {}),
          });
        }
      });
      tagsExtension = compact({
        attributes: tagsAttrs.rest(),
        children: tagKids.rest(),
        tags: tagExtras.length > 0 ? tagExtras : undefined,
      });
    }

    const workoutElement = kids.takeFirst('workout');
    if (!workoutElement) {
      throw new ImportError('no-workout', 'The file has no <workout> element.', 'workout_file');
    }
    const workoutAttrs = new Attrs(workoutElement);
    const workoutKids = new Kids(workoutElement);

    const distance = durationType?.toLowerCase() === 'distance';
    if (durationType !== undefined && !['time', 'distance'].includes(durationType.toLowerCase())) {
      diagnostics.warn(
        'unknown-duration-type',
        `durationType "${durationType}" is neither time nor distance; durations are read as seconds.`,
        'workout_file/durationType',
      );
    }
    const context = new Context(diagnostics, distance);

    const steps: WorkoutStep[] = [];
    workoutKids.elements.forEach((element, index) => {
      if (!STEP_ELEMENTS.has(element.name.toLowerCase())) {
        diagnostics.warn(
          'unknown-element',
          `<${element.name}> is not a ZWO step; it is kept in the extensions.`,
          at(element, index),
        );
        return;
      }
      workoutKids.take(element);
      steps.push(stepOf(element, index, String(steps.length + 1), context));
    });

    const name = nameText || baseName(options.fileName) || 'Untitled workout';
    if (!nameText) {
      diagnostics.warn(
        'missing-name',
        `The workout has no name; "${name}" is used.`,
        'workout_file/name',
      );
    }

    const workoutExtension = compact({
      attributes: workoutAttrs.rest(),
      children: workoutKids.rest(),
    });
    const extension = compact({
      elementOrder: root.children.flatMap((n) => ('name' in n ? [n.name] : [])),
      attributeOrder: rootAttrs.names.length > 0 ? rootAttrs.names : undefined,
      attributes: rootAttrs.rest(),
      sportType,
      durationType,
      fields: Object.keys(fieldExtras).length > 0 ? fieldExtras : undefined,
      tags: tagsExtension && Object.keys(tagsExtension).length > 0 ? tagsExtension : undefined,
      workout: Object.keys(workoutExtension).length > 0 ? workoutExtension : undefined,
      children: kids.rest(),
    });

    const workout: Workout = {
      format: 'ridrs-workout',
      version: 1,
      id: workoutId(options, name),
      name,
      ...(description ? { description } : {}),
      sport: 'ride',
      ...(author ? { author } : {}),
      ...(category ? { category } : {}),
      ...(subcategory ? { subcategory } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      source: sourceOf('zwo', options),
      steps,
      extensions: { zwo: extension },
    };
    return [workout];
  });
