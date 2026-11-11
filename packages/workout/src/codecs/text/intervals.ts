// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  Workout,
  WorkoutCue,
  WorkoutDuration,
  WorkoutEffort,
  WorkoutIntensity,
  WorkoutInterval,
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
  sourceOf,
  workoutId,
} from './common.ts';

/**
 * The workout text of intervals.icu, as pasted from a description. The syntax is public, from the
 * intervals.icu forum (nothing of it is official in one place):
 * - "Workout Builder Syntax Quick Guide": https://forum.intervals.icu/t/workout-builder-syntax-quick-guide/123701
 *   (step lines `- 10m 75% 90rpm`, durations `30s` `10m` `1m30` `5m30s` `1'30"` and distances
 *   `5km` `4.5mi` `500mtr`, targets `95-105%` `200w` `Z2` `Z2 HR` `75-80% HR` `90-95% LTHR`, `ramp`,
 *   `freeride`, `Nx` repeats, text before a duration, timed prompts `33^text <!> 10m 75%`);
 * - "Workout builder": https://forum.intervals.icu/t/workout-builder/1163 (the first description,
 *   `Warmup` / `Main set 6x` sections, `Ramp 60-80%`, press lap).
 * `maxeffort`, `RPE` and `intensity=` are not in those pages; they follow the brief of the plan and
 * are read leniently. Pace targets (`80% Pace`, `5:00/km`) belong to running and swimming: refused.
 *
 * Mapping decisions: the text before a step's duration is its `name`; text after the targets is
 * `notes`; timed prompts are `cues`. Plain lines (sections such as `Warmup`, other text) are kept in
 * `extensions.intervals.lines`, each with the id of the step it stands before; a `Main set 6x` line
 * becomes the repeat, its line kept in the repeat's extensions. A step line that cannot be read as
 * a step stays a plain line, with a warning.
 */

interface Found {
  index: number;
  length: number;
  duration: WorkoutDuration;
}

const NUMBER = String.raw`\d+(?:\.\d+)?`;

const MILE = 1609.344;

/** The first duration in a text: time (`1h30m`, `5m30s`, `1m30`, `90s`, `1'30"`) or distance. */
function findDuration(text: string): Found | undefined {
  const found: Found[] = [];
  const add = (match: RegExpMatchArray, duration: WorkoutDuration): void => {
    found.push({ index: match.index ?? 0, length: match[0].length, duration });
  };
  const n = (value: string | undefined): number => (value === undefined ? 0 : Number(value));

  for (const m of text.matchAll(
    new RegExp(String.raw`(?<![\w.])(${NUMBER})\s?(km|mi|mtr)(?![a-z])`, 'gi'),
  )) {
    const meters = n(m[1]) * ({ km: 1000, mi: MILE, mtr: 1 }[(m[2] ?? '').toLowerCase()] ?? 1);
    add(m, { kind: 'distance', meters: Math.round(meters * 1000) / 1000 });
  }
  const timed = (m: RegExpMatchArray, h?: string, min?: string, s?: string): void => {
    const seconds = Math.round((n(h) * 3600 + n(min) * 60 + n(s)) * 1000) / 1000;
    add(m, { kind: 'time', seconds });
  };
  for (const m of text.matchAll(
    new RegExp(String.raw`(?<![\w.])(?:(${NUMBER})h)?(${NUMBER})m(\d+)(?![\w%.])`, 'gi'),
  )) {
    timed(m, m[1], m[2], m[3]);
  }
  for (const m of text.matchAll(
    new RegExp(
      String.raw`(?<![\w.])(?:(${NUMBER})h)?(?:(${NUMBER})m(?!tr|i))?(?:(${NUMBER})s)?(?![\w.])`,
      'gi',
    ),
  )) {
    if (m[0] !== '') timed(m, m[1], m[2], m[3]);
  }
  for (const m of text.matchAll(/(?<![\w.])(\d+)'(?:(\d+)")?/g)) timed(m, undefined, m[1], m[2]);

  return found.sort((a, b) => a.index - b.index || b.length - a.length)[0];
}

const INTENSITIES: Record<string, WorkoutIntensity> = {
  warmup: 'warm-up',
  active: 'active',
  interval: 'interval',
  rest: 'rest',
  recovery: 'recovery',
  cooldown: 'cool-down',
};

interface Parsed {
  name?: string;
  duration: WorkoutDuration;
  effort: WorkoutEffort;
  intensity?: WorkoutIntensity;
  cues: WorkoutCue[];
  notes?: string;
  extension: Record<string, unknown>;
}

/** The text of a step line (after the dash), or `undefined` if it is no step. */
function parseStep(body: string, diagnostics: Diagnostics, place: string): Parsed | undefined {
  const cues: WorkoutCue[] = [];
  let text = body.trim();
  let name: string | undefined;

  const marker = text.indexOf('<!>');
  if (marker >= 0) {
    // `prompt at 0 s  33^prompt at 33 s <!> 10m ramp 25-75%`
    const [first, ...pairs] = text.slice(0, marker).split(/(\d+)\^/);
    if (first?.trim()) cues.push({ offsetSeconds: 0, text: first.trim() });
    for (let i = 0; i + 1 < pairs.length; i += 2) {
      const at = Number(pairs[i]);
      const prompt = (pairs[i + 1] ?? '').trim();
      if (prompt) cues.push({ offsetSeconds: at, text: prompt });
    }
    text = text.slice(marker + 3).trim();
  }

  let duration: WorkoutDuration;
  const found = findDuration(text);
  if (found) {
    if (marker < 0) name = text.slice(0, found.index).trim() || undefined;
    else if (found.index > 0) text = text.slice(found.index);
    duration = found.duration;
    text = marker < 0 ? text.slice(found.index + found.length) : text.slice(found.length);
  } else if (/press lap/i.test(text)) {
    duration = { kind: 'open' };
  } else {
    return undefined;
  }

  if (/\bpace\b|\d:\d{2}\s*\/\s*\w+/i.test(text) || /\bpace\b/i.test(name ?? '')) {
    throw new ImportError(
      'not-cycling',
      `${place}: a pace target belongs to running or swimming; only cycling workouts are imported.`,
      place,
    );
  }

  let rest = text;
  const hits: { pos: number; target?: WorkoutTarget; cadence?: boolean; raw: string }[] = [];
  const unmapped: string[] = [];
  /** Finds every match, blanks it out of `rest` and hands it on. */
  const extract = (re: RegExp, handle: (m: RegExpMatchArray) => void): void => {
    for (const m of rest.matchAll(re)) handle(m);
    rest = rest.replace(re, (m) => ' '.repeat(m.length));
  };
  const flag = (re: RegExp): boolean => {
    const present = re.test(rest);
    if (present) rest = rest.replace(re, (m) => ' '.repeat(m.length));
    return present;
  };
  const range = (low: string, high: string | undefined) => {
    const l = Number(low);
    return { low: l, high: high === undefined ? l : Number(high) };
  };

  let intensity: WorkoutIntensity | undefined;
  let intensityText: string | undefined;
  extract(/\bintensity=(\w+)/gi, (m) => {
    intensityText = m[1];
    intensity = INTENSITIES[(m[1] ?? '').toLowerCase()];
    if (!intensity) {
      diagnostics.warn(
        'unknown-intensity',
        `${place}: intensity=${m[1]} is not known; kept in the extensions.`,
        place,
      );
    }
  });
  const ramp = flag(/\bramp\b/gi);
  const maxEffort = flag(/\bmax\s?effort\b/gi);
  const free = flag(/\bfree(?:ride)?\b/gi);
  extract(new RegExp(String.raw`(${NUMBER})(?:\s*-\s*(${NUMBER}))?\s*rpm\b`, 'gi'), (m) => {
    hits.push({
      pos: m.index ?? 0,
      cadence: true,
      target: { unit: 'rpm', start: range(m[1] ?? '0', m[2]) },
      raw: m[0],
    });
  });
  extract(new RegExp(String.raw`\brpe\s*(${NUMBER})(?:\s*-\s*(${NUMBER}))?`, 'gi'), (m) => {
    hits.push({
      pos: m.index ?? 0,
      target: { unit: 'rpe', start: range(m[1] ?? '0', m[2]) },
      raw: m[0],
    });
  });
  // Targets ridrs has no unit for: kept as written.
  extract(
    new RegExp(
      String.raw`${NUMBER}(?:\s*-\s*${NUMBER})?\s*%\s*mmp(?:\s+(?:${NUMBER}[hms])+)?|\bcz\d+(?:\s*-\s*cz\d+)?`,
      'gi',
    ),
    (m) => {
      unmapped.push(m[0]);
    },
  );
  extract(/\bz(\d+)(?:\s*-\s*z?(\d+))?(\s+hr\b)?/gi, (m) => {
    hits.push({
      pos: m.index ?? 0,
      target: { unit: m[3] ? 'hr-zone' : 'power-zone', start: range(m[1] ?? '0', m[2]) },
      raw: m[0],
    });
  });
  extract(
    new RegExp(
      String.raw`(${NUMBER})(?:\s*(?:%|w|bpm)?\s*-\s*(${NUMBER}))?\s*(%|w|bpm)(?![a-z])(?:\s*(ftp|lthr|hr)\b)?`,
      'gi',
    ),
    (m) => {
      const unit = (m[3] ?? '').toLowerCase();
      const system = (m[4] ?? '').toLowerCase();
      const unitOf: WorkoutTarget['unit'] =
        unit === 'w'
          ? 'watts'
          : unit === 'bpm'
            ? 'bpm'
            : system === 'lthr'
              ? 'percent-lthr'
              : system === 'hr'
                ? 'percent-max-hr'
                : 'percent-ftp';
      hits.push({
        pos: m.index ?? 0,
        target: { unit: unitOf, start: range(m[1] ?? '0', m[2]) },
        raw: m[0],
      });
    },
  );
  hits.sort((a, b) => a.pos - b.pos);

  const targets = hits.flatMap((h) => (h.target ? [h] : []));
  let effort: WorkoutEffort;
  if (maxEffort) {
    effort = { kind: 'max-effort' };
    for (const h of targets) unmapped.push(h.raw);
  } else if (free) {
    const secondary = targets.map((h) => h.target as WorkoutTarget);
    effort = { kind: 'free', ...(secondary.length > 0 ? { secondary } : {}) };
  } else {
    const primary = targets.find((h) => !h.cadence) ?? undefined;
    const others = targets.filter((h) => h !== primary).map((h) => h.target as WorkoutTarget);
    if (primary?.target) {
      let target = primary.target;
      if (ramp) {
        if (target.start.low === target.start.high) {
          diagnostics.warn(
            'ramp-without-range',
            `${place}: "ramp" without a range is read as steady.`,
            place,
          );
        } else {
          target = {
            unit: target.unit,
            start: { low: target.start.low, high: target.start.low },
            end: { low: target.start.high, high: target.start.high },
          };
        }
      }
      effort = {
        kind: 'target',
        primary: target,
        ...(others.length > 0 ? { secondary: others } : {}),
      };
    } else {
      if (ramp)
        diagnostics.warn(
          'ramp-without-range',
          `${place}: "ramp" without a target is ignored.`,
          place,
        );
      effort = { kind: 'free', ...(others.length > 0 ? { secondary: others } : {}) };
    }
  }

  if (unmapped.length > 0) {
    diagnostics.warn(
      'unsupported-target',
      `${place}: ${unmapped.join(', ')} has no unit in the workout format; kept in the extensions.`,
      place,
    );
  }
  const notes = rest.replace(/\s+/g, ' ').trim();
  const extension = compact({
    line:
      notes || unmapped.length > 0 || (intensityText !== undefined && !intensity)
        ? body.trim()
        : undefined,
    unmapped: unmapped.length > 0 ? unmapped : undefined,
    intensity: intensityText !== undefined && !intensity ? intensityText : undefined,
  });
  return {
    ...(name ? { name } : {}),
    duration,
    effort,
    ...(intensity ? { intensity } : {}),
    cues,
    ...(notes ? { notes } : {}),
    extension,
  };
}

const REPEAT_HEADER = /^(?:(.*\S)\s+)?(\d+)\s*x$/i;

export const importIntervalsText: WorkoutImporter = (input, options = {}) =>
  guarded((diagnostics) => {
    const lines = decodeText(input).split(/\r\n|\r|\n/);
    const steps: WorkoutStep[] = [];
    const plain: { text: string; before?: string }[] = [];
    let pending: { text: string; before?: string }[] = [];
    let block: { repeat: WorkoutRepeat & { steps: WorkoutStep[] }; place: string } | undefined;

    const nextId = (): string =>
      block ? `${block.repeat.id}.${block.repeat.steps.length + 1}` : String(steps.length + 1);
    const claim = (id: string): void => {
      for (const line of pending) line.before = id;
      pending = [];
    };
    const closeBlock = (): void => {
      if (block && block.repeat.steps.length === 0) {
        diagnostics.warn('empty-repeat', `${block.place} has no steps.`, block.place);
      }
      block = undefined;
    };

    lines.forEach((raw, i) => {
      const line = raw.trim();
      const where = `line ${i + 1}`;
      if (line === '') {
        closeBlock();
        return;
      }

      if (/^-(?!-)/.test(line)) {
        const id = nextId();
        const parsed = parseStep(line.slice(1), diagnostics, `${where}`);
        if (!parsed) {
          diagnostics.warn(
            'text-line',
            `${where} is a dash line without a duration; kept as text: ${line}`,
            where,
          );
          const entry = { text: line };
          plain.push(entry);
          pending.push(entry);
          return;
        }
        if (!block) claim(id);
        const interval: WorkoutInterval = {
          kind: 'interval',
          id,
          ...(parsed.name ? { name: parsed.name } : {}),
          ...(parsed.notes ? { notes: parsed.notes } : {}),
          ...(parsed.intensity ? { intensity: parsed.intensity } : {}),
          duration: parsed.duration,
          effort: parsed.effort,
          ...(parsed.cues.length > 0 ? { cues: parsed.cues } : {}),
          ...(Object.keys(parsed.extension).length > 0
            ? { extensions: { intervals: parsed.extension } }
            : {}),
        };
        (block ? block.repeat.steps : steps).push(interval);
        return;
      }

      const header = REPEAT_HEADER.exec(line);
      if (header) {
        closeBlock();
        const id = String(steps.length + 1);
        claim(id);
        const reps = Number(header[2]);
        if (reps < 1) {
          throw new ImportError('bad-repetitions', `${where}: "${line}" repeats nothing.`, where);
        }
        const repeat: WorkoutRepeat & { steps: WorkoutStep[] } = {
          kind: 'repeat',
          id,
          until: { kind: 'count', reps },
          steps: [],
          extensions: { intervals: compact({ header: line, name: header[1] }) },
        };
        steps.push(repeat);
        block = { repeat, place: where };
        return;
      }

      closeBlock();
      const entry = { text: line };
      plain.push(entry);
      pending.push(entry);
    });
    closeBlock();

    if (steps.length === 0) {
      throw new ImportError(
        'no-steps',
        'The text has no workout steps; a step is a line like "- 10m 75%".',
      );
    }

    const name = baseName(options.fileName) ?? 'Untitled workout';
    if (baseName(options.fileName) === undefined) {
      diagnostics.warn('missing-name', 'The text has no name; "Untitled workout" is used.');
    }
    const workout: Workout = {
      format: 'ridrs-workout',
      version: 1,
      id: workoutId(options, name),
      name,
      sport: 'ride',
      source: sourceOf('intervals', options),
      steps,
      ...(plain.length > 0 ? { extensions: { intervals: { lines: plain } } } : {}),
    };
    return [workout];
  });
