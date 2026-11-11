// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  Workout,
  WorkoutCue,
  WorkoutInterval,
  WorkoutRepeat,
  WorkoutStep,
  WorkoutTarget,
} from '@ridrs/contracts';
import { record } from './common.ts';
import {
  extensionOf,
  finishExport,
  middle,
  Notes,
  POWER_UNITS,
  PowerConverter,
  placeOf,
  primaryOf,
  secondaryOf,
  secondsOf,
  unroll,
  type WorkoutExport,
  type WorkoutExportOptions,
} from './shared.ts';
import { el, interleave, placedNodes, renderXml, type XNode } from './xmlout.ts';

/**
 * Zwift workout files (ZWO), the elements `importZwo` reads. Power is a fraction of FTP: watts are
 * converted to % FTP with the FTP, ranges to their middle. A repeat of two steps is an
 * `IntervalsT`; other repeats are written out. Heart rate, distance (unless the whole workout
 * goes by distance, as `durationType` says), lap-button and bound steps become time steps, and a
 * target ZWO cannot hold a free ride. An export of a ZWO workout restores `extensions.zwo` as far
 * as the steps still match what it describes.
 */

const fraction = (percent: number): string =>
  String(Number(`${Math.round(percent * 100) / 100}e-2`));
const plain = (value: number): string => String(Math.round(value * 1000) / 1000);

type Pairs = [string, string][];

/** Attribute pairs: the extension's order and spelling first, then what it did not have. */
function orderedAttributes(
  known: Pairs,
  extension: Record<string, unknown> | undefined,
  fallbackOrder: readonly string[] = [],
): Pairs {
  const byName = new Map(
    known.map(([name, value]) => [name.toLowerCase(), [name, value] as const]),
  );
  const unknown = record(extension?.attributes) ?? {};
  const order = Array.isArray(extension?.attributeOrder)
    ? (extension.attributeOrder as unknown[]).filter((n): n is string => typeof n === 'string')
    : fallbackOrder;
  const out: Pairs = [];
  const used = new Set<string>();
  for (const name of order) {
    const hit = byName.get(name.toLowerCase());
    if (hit && !used.has(hit[0])) {
      out.push([name, hit[1]]);
      used.add(hit[0]);
    } else if (!hit && typeof unknown[name] === 'string') {
      out.push([name, unknown[name] as string]);
      used.add(name);
    }
  }
  for (const [name, value] of known) if (!used.has(name)) out.push([name, value]);
  for (const [name, value] of Object.entries(unknown)) {
    if (
      !out.some(([n]) => n === name) &&
      !byName.has(name.toLowerCase()) &&
      typeof value === 'string'
    ) {
      out.push([name, value]);
    }
  }
  return out;
}

interface Context {
  readonly notes: Notes;
  readonly power: PowerConverter;
  readonly distance: boolean;
}

/** `textevent` elements: the cues, with what the importer kept beyond them. */
function textevents(
  cues: readonly WorkoutCue[] | undefined,
  extension: Record<string, unknown> | undefined,
): { known: XNode[]; placed: { index: number; node: XNode }[] } {
  const extras = Array.isArray(extension?.textevents) ? extension.textevents.map(record) : [];
  const known = (cues ?? []).map((cue, i): XNode => {
    const more = extras.find((e) => e?.index === i && record(e.attributes));
    const pairs: Pairs = [
      ['timeoffset', plain(cue.offsetSeconds)],
      ['message', cue.text],
      ...(cue.durationSeconds === undefined
        ? []
        : ([['duration', plain(cue.durationSeconds)]] as Pairs)),
      ...Object.entries(record(more?.attributes) ?? {}).map(
        ([k, v]) => [k, String(v)] as [string, string],
      ),
    ];
    return el('textevent', pairs);
  });
  const placed = placedNodes(extras.flatMap((e) => (e && 'node' in e ? [e] : [])));
  return { known, placed };
}

/** What a step can be in ZWO, and the elements of that kind. */
const STEADY = ['steadystate', 'solidstate'];

function intervalElement(step: WorkoutInterval, context: Context): XNode {
  const { notes, power, distance } = context;
  const extension = extensionOf(step, 'zwo');
  const at = placeOf(step);
  const seconds = distance && step.duration.kind === 'distance' ? step.duration.meters : undefined;
  const length = seconds ?? secondsOf(step, notes, 'zwo');

  const known: Pairs = [['Duration', plain(length)]];
  let kind: 'steady' | 'ramp' | 'free' | 'max' = 'free';
  const cadence: WorkoutTarget[] = [];
  const primary = primaryOf(step);
  if (step.effort.kind === 'max-effort') {
    kind = 'max';
  } else if (primary && POWER_UNITS.has(primary.unit)) {
    const start = power.percent(primary.start, primary.unit, at) ?? { low: 0, high: 0 };
    const end = primary.end
      ? (power.percent(primary.end, primary.unit, at) ?? { low: 0, high: 0 })
      : undefined;
    if (start.low !== start.high || (end && end.low !== end.high)) {
      notes.warn(
        'range-to-middle',
        `${at}: a range is written as its middle; ZWO holds one value.`,
        step.id,
      );
    }
    if (end) {
      kind = 'ramp';
      known.push(['PowerLow', fraction(middle(start))], ['PowerHigh', fraction(middle(end))]);
    } else {
      kind = 'steady';
      known.push(['Power', fraction(middle(start))]);
    }
  } else if (primary) {
    if (primary.unit === 'rpm') {
      cadence.push(primary);
    } else {
      notes.warn(
        'target-to-free-ride',
        `${at}: a target in ${primary.unit} cannot be written in ZWO; the step is a free ride.`,
        step.id,
      );
    }
  }
  for (const target of secondaryOf(step)) {
    if (target.unit === 'rpm' && kind !== 'max') cadence.push(target);
    else {
      notes.warn(
        'secondary-dropped',
        `${at}: a ${target.unit} target beside the power cannot be written in ZWO.`,
        step.id,
      );
    }
  }
  const cad = cadence[0];
  if (cad && kind !== 'max') {
    if (cad.start.low === cad.start.high) known.push(['Cadence', plain(cad.start.low)]);
    else known.push(['CadenceLow', plain(cad.start.low)], ['CadenceHigh', plain(cad.start.high)]);
  }
  if (kind === 'free' && step.effort.kind === 'free' && step.effort.flatRoad !== undefined) {
    known.push(['FlatRoad', step.effort.flatRoad ? '1' : '0']);
  }

  const allowed: Record<typeof kind, string[]> = {
    steady: STEADY,
    ramp: [
      'ramp',
      ...(step.intensity === 'warm-up' ? ['warmup'] : []),
      ...(step.intensity === 'cool-down' ? ['cooldown'] : []),
    ],
    free: ['freeride'],
    max: ['maxeffort'],
  };
  const spelled = typeof extension?.element === 'string' ? extension.element : undefined;
  const restores = spelled !== undefined && allowed[kind].includes(spelled.toLowerCase());
  const name = restores
    ? spelled
    : kind === 'steady'
      ? 'SteadyState'
      : kind === 'ramp'
        ? step.intensity === 'warm-up'
          ? 'Warmup'
          : step.intensity === 'cool-down'
            ? 'Cooldown'
            : 'Ramp'
        : kind === 'free'
          ? 'FreeRide'
          : 'MaxEffort';
  const own = restores ? extension : undefined;
  const events = textevents(step.cues, own);
  const children = interleave(events.known, [...placedNodes(own?.children), ...events.placed]);
  return el(name, orderedAttributes(known, own), children);
}

/** Whether a repeat is an `IntervalsT`: two steady power steps, a count, no cues. */
function intervalsT(
  repeat: WorkoutRepeat,
  context: Context,
): { on: WorkoutInterval; off: WorkoutInterval } | undefined {
  if (repeat.until.kind !== 'count' || repeat.steps.length !== 2) return undefined;
  const [on, off] = repeat.steps;
  if (on?.kind !== 'interval' || off?.kind !== 'interval') return undefined;
  for (const step of [on, off]) {
    const p = primaryOf(step);
    const lengthOk = context.distance
      ? step.duration.kind === 'distance'
      : step.duration.kind === 'time';
    if (!p || !POWER_UNITS.has(p.unit) || p.end || !lengthOk || step.cues?.length) return undefined;
  }
  const offCadence = secondaryOf(off);
  if (
    offCadence.length > 1 ||
    offCadence.some((t) => t.unit !== 'rpm' || t.start.low !== t.start.high)
  )
    return undefined;
  if (secondaryOf(on).some((t) => t.unit !== 'rpm')) return undefined;
  return { on, off };
}

function repeatElement(
  repeat: WorkoutRepeat,
  parts: { on: WorkoutInterval; off: WorkoutInterval },
  context: Context,
): XNode {
  const { notes, power, distance } = context;
  const extension = extensionOf(repeat, 'zwo');
  const { on, off } = parts;
  const value = (step: WorkoutInterval): string => {
    const p = primaryOf(step) as WorkoutTarget;
    const range = power.percent(p.start, p.unit, placeOf(step)) ?? { low: 0, high: 0 };
    if (range.low !== range.high) {
      notes.warn(
        'range-to-middle',
        `${placeOf(step)}: a range is written as its middle; ZWO holds one value.`,
        step.id,
      );
    }
    return fraction(middle(range));
  };
  const length = (step: WorkoutInterval): string =>
    plain(
      step.duration.kind === 'distance' && distance
        ? step.duration.meters
        : secondsOf(step, notes, 'zwo'),
    );
  const known: Pairs = [
    ['Repeat', String((repeat.until as { reps: number }).reps)],
    ['OnDuration', length(on)],
    ['OffDuration', length(off)],
    ['OnPower', value(on)],
    ['OffPower', value(off)],
  ];
  const onCadence = secondaryOf(on)[0];
  if (onCadence) {
    if (onCadence.start.low === onCadence.start.high)
      known.push(['Cadence', plain(onCadence.start.low)]);
    else
      known.push(
        ['CadenceLow', plain(onCadence.start.low)],
        ['CadenceHigh', plain(onCadence.start.high)],
      );
  }
  const offCadence = secondaryOf(off)[0];
  if (offCadence) known.push(['CadenceResting', plain(offCadence.start.low)]);
  const restores =
    typeof extension?.element === 'string' && extension.element.toLowerCase() === 'intervalst';
  const own = restores ? extension : undefined;
  // Cues of an IntervalsT live in the extension: they count from its start.
  const kept = Array.isArray(own?.textevents) ? own.textevents.map(record) : [];
  const full = kept.filter((e) => record(e?.attributes)?.timeoffset !== undefined);
  const events: XNode[] = full.map((e, i) => {
    const merged = { ...(record(e?.attributes) ?? {}) };
    for (const part of kept) {
      if (
        part &&
        part !== e &&
        part.index === i &&
        record(part.attributes) &&
        record(part.attributes)?.timeoffset === undefined
      ) {
        Object.assign(merged, part.attributes);
      }
    }
    return el(
      'textevent',
      Object.entries(merged).map(([k, v]) => [k, String(v)] as [string, string]),
    );
  });
  const placed = [
    ...placedNodes(own?.children),
    ...placedNodes(kept.filter((e) => e && 'node' in e)),
  ];
  return el(
    restores ? String(extension?.element) : 'IntervalsT',
    orderedAttributes(known, own),
    interleave(events, placed),
  );
}

/** The elements of the steps of a workout. */
function stepElements(steps: readonly WorkoutStep[], context: Context): XNode[] {
  const out: XNode[] = [];
  for (const step of steps) {
    if (step.kind === 'interval') {
      out.push(intervalElement(step, context));
      continue;
    }
    const parts = intervalsT(step, context);
    if (parts) {
      out.push(repeatElement(step, parts, context));
      continue;
    }
    context.notes.warn(
      'repeat-unrolled',
      `A repeat of ${placeOf(step)} is written out step by step; ZWO repeats only an on and an off step (IntervalsT).`,
      step.id,
    );
    const rounds = step.until.kind === 'count' ? step.until.reps : 1;
    if (step.until.kind !== 'count') {
      context.notes.warn(
        'repeat-until-once',
        `A repeat that ends by ${step.until.kind} is written once; ZWO repeats by count only.`,
        step.id,
      );
    }
    for (let round = 0; round < rounds; round += 1) out.push(...stepElements(step.steps, context));
  }
  return out;
}

function allDurationsAreDistance(steps: readonly WorkoutStep[]): boolean {
  let any = false;
  const walk = (list: readonly WorkoutStep[]): boolean =>
    list.every((step) => {
      if (step.kind === 'repeat') return walk(step.steps);
      any = true;
      return step.duration.kind === 'distance';
    });
  return walk(steps) && any;
}

/** The text of a metadata element, with what it carried beyond its text. */
function field(
  name: string,
  value: string,
  extension: Record<string, unknown> | undefined,
  cdata = false,
): XNode {
  const more = record(record(extension?.fields)?.[name]);
  const attrs = Object.entries(record(more?.attributes) ?? {}).map(
    ([k, v]) => [k, String(v)] as [string, string],
  );
  const text: XNode =
    cdata && /[<&]/.test(value) && !value.includes(']]>') ? { cdata: value } : { text: value };
  return el(name, attrs, [text, ...placedNodes(more?.children).map((c) => c.node)]);
}

export function exportZwo(
  workout: Workout,
  options: WorkoutExportOptions = {},
): WorkoutExport<string> {
  const notes = new Notes();
  const extension = extensionOf(workout, 'zwo');
  const distance =
    typeof extension?.durationType === 'string' &&
    extension.durationType.toLowerCase() === 'distance' &&
    allDurationsAreDistance(workout.steps);
  const context: Context = { notes, power: new PowerConverter(options, notes), distance };

  const steps = stepElements(workout.steps, context);
  const hasDetails = unroll(workout.steps, new Notes(), 'zwo').some((s) => s.name || s.notes);
  if (hasDetails) {
    notes.warn('step-names-dropped', 'ZWO has no names or notes for steps; they are not written.');
  }
  if (workout.referenceFtp || workout.focus || workout.declared || workout.subSport) {
    notes.warn(
      'metadata-dropped',
      'ZWO has no place for the reference FTP, focus, declared values and sub sport.',
    );
  }

  return finishExport('zwo', notes, () => {
    const workoutExt = record(extension?.workout);
    const workoutNode = el(
      'workout',
      Object.entries(record(workoutExt?.attributes) ?? {}).map(
        ([k, v]) => [k, String(v)] as [string, string],
      ),
      interleave(steps, placedNodes(workoutExt?.children)),
    );
    const known = new Map<string, XNode>();
    known.set('author', field('author', workout.author ?? '', extension));
    known.set('name', field('name', workout.name, extension));
    if (workout.description)
      known.set('description', field('description', workout.description, extension, true));
    known.set(
      'sporttype',
      field(
        'sportType',
        typeof extension?.sportType === 'string' ? extension.sportType : 'bike',
        extension,
      ),
    );
    if (distance || typeof extension?.durationType === 'string') {
      known.set('durationtype', field('durationType', distance ? 'distance' : 'time', extension));
    }
    if (workout.category) known.set('category', field('category', workout.category, extension));
    if (workout.subcategory)
      known.set('subcategory', field('subcategory', workout.subcategory, extension));
    const tagsExt = record(extension?.tags);
    if ((workout.tags?.length ?? 0) > 0 || tagsExt?.attributes || tagsExt?.children) {
      const extras = Array.isArray(tagsExt?.tags) ? tagsExt.tags.map(record) : [];
      const bad = extras.flatMap((e) => (e && 'node' in e ? [e] : []));
      const tagNodes = (workout.tags ?? []).map((tag, i): XNode => {
        const more = extras.find((e) => e?.index === i && !('node' in e));
        return el('tag', [
          ['name', tag],
          ...Object.entries(record(more?.attributes) ?? {}).map(
            ([k, v]) => [k, String(v)] as [string, string],
          ),
        ]);
      });
      known.set(
        'tags',
        el(
          'tags',
          Object.entries(record(tagsExt?.attributes) ?? {}).map(
            ([k, v]) => [k, String(v)] as [string, string],
          ),
          [
            ...interleave(tagNodes, placedNodes(bad)),
            ...placedNodes(tagsExt?.children).map((c) => c.node),
          ],
        ),
      );
    }
    known.set('workout', workoutNode);

    const order = Array.isArray(extension?.elementOrder)
      ? (extension.elementOrder as unknown[]).filter((n): n is string => typeof n === 'string')
      : [];
    const placed = placedNodes(extension?.children);
    const children: XNode[] = [];
    const emitted = new Set<string>();
    const fallback = [
      'author',
      'name',
      'description',
      'sporttype',
      'durationtype',
      'category',
      'subcategory',
      'tags',
      'workout',
    ];
    const sequence = order.length > 0 ? order : fallback;
    sequence.forEach((name, position) => {
      const here = placed.filter((p) => p.index === position);
      if (here.length > 0) {
        children.push(...here.map((p) => p.node));
        return;
      }
      const hit = known.get(name.toLowerCase());
      if (hit && !emitted.has(name.toLowerCase())) {
        children.push(hit);
        emitted.add(name.toLowerCase());
      }
    });
    // What the order does not name (added after the import) goes in its usual place.
    for (const name of fallback) {
      const hit = known.get(name);
      if (hit && !emitted.has(name)) {
        const at = children.indexOf(known.get('workout') as XNode);
        children.splice(name === 'workout' || at < 0 ? children.length : at, 0, hit);
        emitted.add(name);
      }
    }
    const root = el('workout_file', orderedAttributes([], extension), children);
    return renderXml(root);
  });
}
