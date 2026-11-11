// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  Workout,
  WorkoutDuration,
  WorkoutEffort,
  WorkoutIntensity,
  WorkoutInterval,
  WorkoutStep,
  WorkoutTarget,
} from '@ridrs/contracts';
import type { WorkoutDiagnostic } from '../../codec.ts';
import { ExportNotes, intervalsExtension, num, record } from './common.ts';

/**
 * The workout text of intervals.icu (structured-workouts.md, sections 9 and 10), the syntax
 * `importIntervalsText` reads (its sources are cited there): one line per step, `- name 10m 75%`,
 * `Nx` blocks closed by a blank line. Watts go as `200w`, zones as `Z2`, ramps as `ramp`,
 * cadence as `rpm`; nothing is converted. What the syntax cannot express (energy and `until`
 * durations, speed targets, nested repeats, cue lengths, …) is written as near as it can and
 * warned about. The text round-trips through `importIntervalsText`.
 */
export interface IntervalsTextExport {
  readonly text: string;
  readonly diagnostics: readonly WorkoutDiagnostic[];
}

const INTENSITY: Partial<Record<WorkoutIntensity, string>> = {
  'warm-up': 'warmup',
  active: 'active',
  interval: 'interval',
  rest: 'rest',
  recovery: 'recovery',
  'cool-down': 'cooldown',
};

/** `1h2m3s`, `10m`, `30s`, `1m30s`. */
export function intervalsTime(seconds: number): string {
  const total = Math.round(seconds * 1000) / 1000;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total - hours * 3600) / 60);
  const rest = Math.round((total - hours * 3600 - minutes * 60) * 1000) / 1000;
  const text = `${hours > 0 ? `${hours}h` : ''}${minutes > 0 ? `${minutes}m` : ''}${rest > 0 ? `${num(rest)}s` : ''}`;
  return text === '' ? '0s' : text;
}

function durationText(duration: WorkoutDuration, notes: ExportNotes, at: string): string {
  switch (duration.kind) {
    case 'time':
      return intervalsTime(duration.seconds);
    case 'distance':
      return duration.meters % 1000 === 0
        ? `${num(duration.meters / 1000)}km`
        : `${num(duration.meters)}mtr`;
    case 'open':
      return 'press lap';
    default:
      notes.warn(
        'duration-not-expressible',
        `${at}: a duration by ${duration.kind} has no intervals.icu text; written as "press lap".`,
        at,
      );
      return 'press lap';
  }
}

const span = (low: number, high: number): string =>
  low === high ? num(low) : `${num(low)}-${num(high)}`;

/** The text of a target over `low`–`high`; `undefined` for a unit the syntax has none for. */
function valueText(unit: WorkoutTarget['unit'], low: number, high: number): string | undefined {
  switch (unit) {
    case 'percent-ftp':
      return `${span(low, high)}%`;
    case 'watts':
      return `${span(low, high)}w`;
    case 'power-zone':
      return low === high ? `Z${num(low)}` : `Z${num(low)}-Z${num(high)}`;
    case 'hr-zone':
      return `${low === high ? `Z${num(low)}` : `Z${num(low)}-Z${num(high)}`} HR`;
    case 'percent-lthr':
      return `${span(low, high)}% LTHR`;
    case 'percent-max-hr':
      return `${span(low, high)}% HR`;
    case 'bpm':
      return `${span(low, high)}bpm`;
    case 'rpm':
      return `${span(low, high)}rpm`;
    case 'rpe':
      return `RPE ${span(low, high)}`;
    default:
      return undefined;
  }
}

/** A target; a ramp only where `ramp` allows it (the primary target of a step). */
function targetText(
  target: WorkoutTarget,
  ramp: boolean,
  notes: ExportNotes,
  at: string,
): string | undefined {
  if (target.averaging !== undefined) {
    notes.warn(
      'averaging-not-expressible',
      `${at}: the averaging of a target has no intervals.icu text.`,
      at,
    );
  }
  const low = target.start.low;
  let high = target.start.high;
  let prefix = '';
  const end = target.end;
  if (end !== undefined) {
    if (!ramp) {
      notes.warn(
        'ramp-not-expressible',
        `${at}: only the first target of a step can ramp; its start is written.`,
        at,
      );
    } else if (end.low === target.start.low && end.high === target.start.high) {
      notes.warn('flat-ramp', `${at}: a ramp to the same value is written steady.`, at);
    } else {
      if (target.start.low !== target.start.high || end.low !== end.high) {
        notes.warn(
          'ramp-of-ranges',
          `${at}: a ramp between ranges is written between their lower bounds.`,
          at,
        );
      }
      high = end.low;
      prefix = 'ramp ';
    }
  }
  const text = valueText(target.unit, low, high);
  if (text === undefined) {
    notes.warn(
      'target-not-expressible',
      `${at}: a ${target.unit} target has no intervals.icu text; left out.`,
      at,
    );
    return undefined;
  }
  return `${prefix}${text}`;
}

function effortText(
  effort: WorkoutEffort,
  implicitFree: boolean,
  notes: ExportNotes,
  at: string,
): string[] {
  if (effort.kind === 'max-effort') {
    return ['maxeffort'];
  }
  const primary =
    effort.kind === 'target' ? targetText(effort.primary, true, notes, at) : undefined;
  const secondary = (effort.secondary ?? []).flatMap(
    (target) => targetText(target, false, notes, at) ?? [],
  );
  if (effort.kind === 'free') {
    if (effort.flatRoad !== undefined) {
      notes.warn(
        'flat-road-not-expressible',
        `${at}: "flat road" of a free ride has no intervals.icu text.`,
        at,
      );
    }
    // A step whose only target had no unit in ridrs was free without saying so.
    return [...(implicitFree ? [] : ['freeride']), ...secondary];
  }
  return [...(primary !== undefined ? [primary] : []), ...secondary];
}

function intervalLine(step: WorkoutInterval, notes: ExportNotes): string {
  const at = `step ${step.id}`;
  const parts: string[] = [];
  if (step.cues && step.cues.length > 0) {
    if (step.name !== undefined) {
      notes.warn(
        'name-with-cues',
        `${at}: a step with timed prompts has no name in intervals.icu text; left out.`,
        at,
      );
    }
    if (step.cues.some((cue) => cue.durationSeconds !== undefined)) {
      notes.warn(
        'cue-length-not-expressible',
        `${at}: how long a prompt shows has no intervals.icu text.`,
        at,
      );
    }
    const prompts = step.cues.map((cue) =>
      cue.offsetSeconds === 0 ? cue.text : `${num(cue.offsetSeconds)}^${cue.text}`,
    );
    parts.push(`${prompts.join(' ')} <!>`);
  } else if (step.name !== undefined) {
    parts.push(step.name);
  }
  parts.push(durationText(step.duration, notes, at));
  const extension = intervalsExtension(step);
  const implicitFree =
    extension.implicitFree === true ||
    (typeof extension.line === 'string' && !/\bfree(?:ride)?\b/i.test(extension.line));
  parts.push(...effortText(step.effort, implicitFree, notes, at));
  if (Array.isArray(extension.unmapped)) {
    parts.push(...extension.unmapped.filter((token): token is string => typeof token === 'string'));
  }
  if (step.intensity !== undefined) {
    const word = INTENSITY[step.intensity];
    if (word === undefined) {
      notes.warn(
        'intensity-not-expressible',
        `${at}: the intensity "${step.intensity}" has no intervals.icu text.`,
        at,
      );
    } else {
      parts.push(`intensity=${word}`);
    }
  } else if (typeof extension.intensity === 'string') {
    parts.push(`intensity=${extension.intensity}`);
  }
  if (step.notes !== undefined) {
    parts.push(step.notes);
  }
  return `- ${parts.join(' ')}`;
}

/** A block of the text: plain lines and steps; a repeat is closed by a blank line. */
type Line = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'blank' };

const containsRepeat = (steps: readonly WorkoutStep[]): boolean =>
  steps.some((step) => step.kind === 'repeat');

export function exportIntervalsText(workout: Workout): IntervalsTextExport {
  const notes = new ExportNotes();
  const lines: Line[] = [];
  const text = (value: string) => lines.push({ kind: 'text', text: value });
  const blank = () => lines.push({ kind: 'blank' });

  // Plain lines of an imported text (sections, comments), before the step they stood before.
  const plain = Array.isArray(intervalsExtension(workout).lines)
    ? (intervalsExtension(workout).lines as unknown[])
    : [];
  const plainBefore = (id: string | undefined) => {
    for (const entry of plain) {
      const line = record(entry);
      if (line && typeof line.text === 'string' && line.before === id) {
        text(line.text);
      }
    }
  };

  /** Steps outside a block; a repeat in them becomes a block. */
  const topLevel = (steps: readonly WorkoutStep[], withPlain: boolean) => {
    for (const step of steps) {
      if (withPlain) {
        plainBefore(step.id);
      }
      if (step.kind === 'interval') {
        text(intervalLine(step, notes));
        continue;
      }
      const at = `step ${step.id}`;
      if (step.until.kind !== 'count') {
        notes.warn(
          'repeat-not-expressible',
          `${at}: a repeat until ${step.until.kind} has no intervals.icu text; its steps are written once.`,
          at,
        );
        topLevel(step.steps, false);
        continue;
      }
      if (containsRepeat(step.steps)) {
        // The syntax has no nested blocks: the outer repeat is written out.
        notes.warn(
          'nested-repeat-unrolled',
          `${at}: a repeat inside a repeat is written out ${step.until.reps} times.`,
          at,
        );
        for (let rep = 0; rep < step.until.reps; rep += 1) {
          topLevel(step.steps, false);
        }
        continue;
      }
      const header = intervalsExtension(step).header;
      const match = typeof header === 'string' ? /(\d+)\s*x$/i.exec(header) : null;
      blank();
      text(
        match && Number(match[1]) === step.until.reps ? (header as string) : `${step.until.reps}x`,
      );
      for (const inner of step.steps) {
        text(intervalLine(inner as WorkoutInterval, notes));
      }
      blank();
    }
  };
  topLevel(workout.steps, true);
  plainBefore(undefined);

  // Blank lines: none at the edges, never two in a row.
  const out: string[] = [];
  for (const line of lines) {
    if (line.kind === 'blank') {
      if (out.length > 0 && out.at(-1) !== '') {
        out.push('');
      }
    } else {
      out.push(line.text);
    }
  }
  while (out.at(-1) === '') {
    out.pop();
  }
  return { text: out.join('\n'), diagnostics: notes.list };
}
