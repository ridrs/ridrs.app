// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  Workout,
  WorkoutIntensity,
  WorkoutInterval,
  WorkoutStep,
  WorkoutTarget,
} from '@ridrs/contracts';
import type { WorkoutDiagnostic } from '../../codec.ts';
import { ExportNotes, intervalsExtension, record } from './common.ts';

/**
 * The `workout_doc` of intervals.icu: the structure an event or a library workout carries. Its
 * shape is not in the OpenAPI spec (an untyped object there); it follows the classes the developer
 * of intervals.icu posted in "Downloading planned workouts from the API"
 * (https://forum.intervals.icu/t/downloading-planned-workouts-from-the-api/93737): a step has
 * `text`, `duration` (s), `distance` (m), `until_lap_press`, `reps` with nested `steps`, `warmup`,
 * `cooldown`, `intensity`, `ramp`, `freeride`, `maxeffort`, and the values `power`, `hr`,
 * `cadence` (and `pace`), each `{ value }` or `{ start, end }` with `units`. Units seen in the
 * forum: `%ftp`, `w`, `power_zone` ("Building workout using zone number instead of percentage
 * range", https://forum.intervals.icu/t/building-workout-using-zone-number-instead-of-percentage-range/4725),
 * `hr_zone`, `%lthr`, `%hr`, `bpm`, `rpm`.
 *
 * Shared with the reader of `planner-intervals-icu`, which keeps in `extensions.intervals` of a
 * step: `doc`, the fields of the step the model has no place for (of a value, its other fields),
 * restored here underneath; `intensityAs: 'text'` when the warm-up or cool-down came as
 * `intensity`; `implicitFree` when a step without a target had no `freeride`.
 */
export interface IntervalsWorkoutDoc {
  readonly steps: readonly Record<string, unknown>[];
  readonly [field: string]: unknown;
}

export interface IntervalsDocExport {
  readonly doc: IntervalsWorkoutDoc;
  readonly diagnostics: readonly WorkoutDiagnostic[];
}

/** The canonical unit → the value slot and the units of a `workout_doc`. */
export const INTERVALS_DOC_UNITS: Readonly<
  Partial<Record<WorkoutTarget['unit'], { slot: 'power' | 'hr' | 'cadence'; units: string }>>
> = {
  'percent-ftp': { slot: 'power', units: '%ftp' },
  watts: { slot: 'power', units: 'w' },
  'power-zone': { slot: 'power', units: 'power_zone' },
  'percent-lthr': { slot: 'hr', units: '%lthr' },
  'percent-max-hr': { slot: 'hr', units: '%hr' },
  bpm: { slot: 'hr', units: 'bpm' },
  'hr-zone': { slot: 'hr', units: 'hr_zone' },
  rpm: { slot: 'cadence', units: 'rpm' },
};

/** The `intensity` words of a `workout_doc` step. */
export const INTERVALS_DOC_INTENSITIES: Readonly<Record<WorkoutIntensity, string>> = {
  'warm-up': 'warmup',
  active: 'active',
  interval: 'interval',
  rest: 'rest',
  recovery: 'recovery',
  'cool-down': 'cooldown',
  other: 'other',
};

function value(
  target: WorkoutTarget,
  units: string,
  notes: ExportNotes,
  at: string,
): Record<string, unknown> {
  if (target.averaging !== undefined) {
    notes.warn(
      'averaging-not-expressible',
      `${at}: the averaging of a target has no place in a workout document.`,
      at,
    );
  }
  if (target.end !== undefined) {
    if (target.start.low !== target.start.high || target.end.low !== target.end.high) {
      notes.warn(
        'ramp-of-ranges',
        `${at}: a ramp between ranges is written between their lower bounds.`,
        at,
      );
    }
    return { units, start: target.start.low, end: target.end.low };
  }
  return target.start.low === target.start.high
    ? { units, value: target.start.low }
    : { units, start: target.start.low, end: target.start.high };
}

function intervalStep(step: WorkoutInterval, notes: ExportNotes): Record<string, unknown> {
  const at = `step ${step.id}`;
  const extension = intervalsExtension(step);
  const kept = record(extension.doc) ?? {};
  const out: Record<string, unknown> = {};
  if (step.name !== undefined) {
    out.text = step.name;
  }
  switch (step.duration.kind) {
    case 'time':
      out.duration = step.duration.seconds;
      break;
    case 'distance':
      out.distance = step.duration.meters;
      break;
    case 'open':
      out.until_lap_press = true;
      break;
    default:
      notes.warn(
        'duration-not-expressible',
        `${at}: a duration by ${step.duration.kind} has no place in a workout document; until the lap button.`,
        at,
      );
      out.until_lap_press = true;
  }
  if (step.intensity === 'warm-up' && extension.intensityAs !== 'text') {
    out.warmup = true;
  } else if (step.intensity === 'cool-down' && extension.intensityAs !== 'text') {
    out.cooldown = true;
  } else if (step.intensity !== undefined) {
    out.intensity = INTERVALS_DOC_INTENSITIES[step.intensity];
  }
  if (step.notes !== undefined) {
    notes.warn(
      'notes-not-expressible',
      `${at}: the notes of a step have no place in a workout document.`,
      at,
    );
  }
  if (step.cues && step.cues.length > 0) {
    notes.warn(
      'cues-not-expressible',
      `${at}: timed prompts have no place in a workout document.`,
      at,
    );
  }

  const effort = step.effort;
  const targets: WorkoutTarget[] = [];
  if (effort.kind === 'max-effort') {
    out.maxeffort = true;
  } else if (effort.kind === 'free') {
    if (extension.implicitFree !== true) {
      out.freeride = true;
    }
    if (effort.flatRoad !== undefined) {
      notes.warn(
        'flat-road-not-expressible',
        `${at}: "flat road" of a free ride has no place in a workout document.`,
        at,
      );
    }
    targets.push(...(effort.secondary ?? []));
  } else {
    targets.push(effort.primary, ...(effort.secondary ?? []));
  }
  for (const target of targets) {
    const mapped = INTERVALS_DOC_UNITS[target.unit];
    if (mapped === undefined || out[mapped.slot] !== undefined) {
      notes.warn(
        'target-not-expressible',
        `${at}: a ${target.unit} target has no place in a workout document; left out.`,
        at,
      );
      continue;
    }
    out[mapped.slot] = { ...record(kept[mapped.slot]), ...value(target, mapped.units, notes, at) };
    if (target.end !== undefined) {
      out.ramp = true;
    }
  }
  return { ...kept, ...out };
}

function docSteps(steps: readonly WorkoutStep[], notes: ExportNotes): Record<string, unknown>[] {
  return steps.flatMap((step): Record<string, unknown>[] => {
    if (step.kind === 'interval') {
      return [intervalStep(step, notes)];
    }
    if (step.until.kind !== 'count') {
      const at = `step ${step.id}`;
      notes.warn(
        'repeat-not-expressible',
        `${at}: a repeat until ${step.until.kind} has no place in a workout document; its steps are written once.`,
        at,
      );
      return docSteps(step.steps, notes);
    }
    const extension = intervalsExtension(step);
    const kept = record(extension.doc) ?? {};
    const header =
      typeof extension.header === 'string' && kept.text === undefined
        ? { text: extension.header }
        : {};
    return [{ ...kept, ...header, reps: step.until.reps, steps: docSteps(step.steps, notes) }];
  });
}

/** A workout as a `workout_doc`; the fields of a document it was read from are restored. */
export function exportIntervalsDoc(workout: Workout): IntervalsDocExport {
  const notes = new ExportNotes();
  const extension = intervalsExtension(workout);
  if (Array.isArray(extension.lines) && extension.lines.length > 0) {
    notes.warn(
      'text-lines-not-expressible',
      'The plain lines of an intervals.icu text have no place in a workout document.',
    );
  }
  const kept = record(extension.doc) ?? {};
  return { doc: { ...kept, steps: docSteps(workout.steps, notes) }, diagnostics: notes.list };
}
