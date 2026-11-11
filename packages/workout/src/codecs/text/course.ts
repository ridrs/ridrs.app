// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  Workout,
  WorkoutCue,
  WorkoutInterval,
  WorkoutSourceFormat,
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

/**
 * ERG and MRC files, the course files of CompuTrainer and many trainer programs. There is no
 * official specification; this follows what the files look like and what TrainerRoad's help
 * describes ("Creating a Workout from an ERG or MRC File"): a `[COURSE HEADER]` with `KEY = value`
 * lines and a column line (`MINUTES WATTS` or `MINUTES PERCENT`), `[COURSE DATA]` with one
 * `minute value` point per line, and an optional `[COURSE TEXT]` with `seconds text seconds`.
 *
 * Points become one step per section, rebuilt exactly: the same value is steady, a different one a
 * ramp, the same minute twice a jump (which is no step: the next step starts at the new value).
 * ERG holds watts and MRC percent of FTP; the column line says which, and nothing is converted.
 */

interface Point {
  minute: number;
  value: number;
  line: number;
}

type HeaderEntry = { key: string; value: string } | { raw: string };

const SECTION = /^\[(.+)\]$/;

const msRound = (seconds: number): number => Math.round(seconds * 1000) / 1000;
const secondsOf = (minute: number): number => msRound(minute * 60);

/**
 * The points a list of steps stands for: the form a file is written in. Used to check that the
 * steps rebuild the file's points exactly; if they do not (a point twice, a first minute other
 * than 0), the file's points are kept in the extensions.
 */
export function pointsOfSteps(
  steps: readonly { seconds: number; start: number; end: number }[],
): [number, number][] {
  const points: [number, number][] = [];
  let seconds = 0;
  for (const step of steps) {
    const last = points[points.length - 1];
    if (!last) points.push([0, step.start]);
    else if (last[1] !== step.start) points.push([last[0], step.start]);
    seconds = msRound(seconds + step.seconds);
    points.push([seconds / 60, step.end]);
  }
  return points;
}

function samePoints(a: readonly (readonly [number, number])[], b: readonly Point[]): boolean {
  return (
    a.length === b.length &&
    a.every(([minute, value], i) => {
      const point = b[i];
      return (
        point !== undefined &&
        Math.abs(secondsOf(minute) - secondsOf(point.minute)) < 0.0005 &&
        value === point.value
      );
    })
  );
}

/** A `[COURSE TEXT]` line: `seconds<TAB>text<TAB>seconds`, the last column optional. */
function parseCue(line: string): WorkoutCue | undefined {
  const tabbed = line.split('\t');
  let offset: number | undefined;
  let text: string;
  let duration: number | undefined;
  if (tabbed.length >= 2) {
    offset = parseNumber(tabbed[0]);
    const last = tabbed.length >= 3 ? parseNumber(tabbed[tabbed.length - 1]) : undefined;
    duration = last;
    text = tabbed.slice(1, last === undefined ? undefined : -1).join('\t');
  } else {
    const match = /^(\d+(?:\.\d+)?)\s+(.*?)(?:\s+(\d+(?:\.\d+)?))?$/.exec(line);
    if (!match) return undefined;
    offset = parseNumber(match[1]);
    text = match[2] ?? '';
    duration = parseNumber(match[3]);
  }
  if (offset === undefined || offset < 0) return undefined;
  return {
    offsetSeconds: offset,
    ...(duration === undefined || duration < 0 ? {} : { durationSeconds: duration }),
    text,
  };
}

function importCourse(
  format: Extract<WorkoutSourceFormat, 'erg' | 'mrc'>,
  input: Uint8Array | string,
  options: Parameters<WorkoutImporter>[1] = {},
) {
  return guarded((diagnostics: Diagnostics) => {
    const lines = decodeText(input).split(/\r\n|\r|\n/);
    const header: HeaderEntry[] = [];
    const sections: { name: string; lines: string[] }[] = [];
    const outside: string[] = [];
    const points: Point[] = [];
    const textLines: { line: string; number: number }[] = [];
    let columns: string | undefined;
    let current: string | undefined;
    let sawData = false;

    lines.forEach((raw, i) => {
      const line = raw.trim();
      const number = i + 1;
      if (line === '') return;
      const marker = SECTION.exec(line);
      if (marker) {
        const name = (marker[1] ?? '').trim().toUpperCase();
        if (name.startsWith('END ')) {
          if (current !== name.slice(4).trim()) {
            diagnostics.warn(
              'misplaced-end',
              `[${marker[1]}] closes no open section.`,
              `line ${number}`,
            );
          }
          current = undefined;
        } else {
          current = name;
          if (name === 'COURSE DATA') sawData = true;
          if (!['COURSE HEADER', 'COURSE DATA', 'COURSE TEXT'].includes(name)) {
            sections.push({ name: marker[1] ?? name, lines: [] });
          }
        }
        return;
      }
      switch (current) {
        case 'COURSE HEADER': {
          if (/^minutes\b/i.test(line)) {
            columns = line;
            return;
          }
          const pair = /^([^=]+?)\s*=\s*(.*)$/.exec(line);
          header.push(pair ? { key: (pair[1] ?? '').trim(), value: pair[2] ?? '' } : { raw: line });
          return;
        }
        case 'COURSE DATA': {
          const cells = line.split(/\s+/);
          const minute = parseNumber(cells[0]);
          const value = parseNumber(cells[1]);
          if (cells.length !== 2 || minute === undefined || value === undefined) {
            throw new ImportError(
              'bad-point',
              `Line ${number} is not a point "minute value": ${line}`,
              `line ${number}`,
            );
          }
          if (minute < 0 || value < 0) {
            throw new ImportError(
              'bad-point',
              `Line ${number} has a negative minute or value: ${line}`,
              `line ${number}`,
            );
          }
          const previous = points[points.length - 1];
          if (previous && minute < previous.minute) {
            throw new ImportError(
              'points-out-of-order',
              `Line ${number}: minute ${minute} comes after minute ${previous.minute}; the minutes of a course never go back.`,
              `line ${number}`,
            );
          }
          points.push({ minute, value, line: number });
          return;
        }
        case 'COURSE TEXT':
          textLines.push({ line, number });
          return;
        case undefined:
          outside.push(line);
          return;
        default:
          sections[sections.length - 1]?.lines.push(line);
      }
    });

    if (!sawData) {
      throw new ImportError(
        'no-course-data',
        'The file has no [COURSE DATA] section; it is not an ERG or MRC file.',
      );
    }

    // The unit is what the column line says; the format is only the fallback.
    const columnUnit = columns ? /^minutes\s+(\S+)/i.exec(columns)?.[1]?.toLowerCase() : undefined;
    const fallback = format === 'erg' ? 'watts' : 'percent-ftp';
    let unit: WorkoutTarget['unit'] = fallback;
    if (columnUnit === 'watts') unit = 'watts';
    else if (columnUnit === 'percent' || columnUnit === '%' || columnUnit === 'ftp') {
      unit = 'percent-ftp';
    } else {
      diagnostics.warn(
        'no-column-header',
        `No "MINUTES WATTS" or "MINUTES PERCENT" line; the values are read as ${fallback}.`,
        'COURSE HEADER',
      );
    }
    if (unit !== fallback && columnUnit !== undefined) {
      diagnostics.warn(
        'unit-mismatch',
        `An ${format.toUpperCase()} file with ${unit} values; they stay ${unit}.`,
        'COURSE HEADER',
      );
    }

    // Header: what has a field is mapped, the rest stays as written.
    let name: string | undefined;
    let description: string | undefined;
    let referenceFtp: number | undefined;
    const keptHeader: HeaderEntry[] = [];
    for (const entry of header) {
      if ('raw' in entry) {
        keptHeader.push(entry);
        continue;
      }
      const key = entry.key.toUpperCase();
      if (key === 'FILE NAME' && name === undefined && entry.value !== '') name = entry.value;
      else if (key === 'DESCRIPTION' && description === undefined && entry.value !== '') {
        description = entry.value;
      } else if (key === 'FTP' && referenceFtp === undefined) {
        const ftp = parseNumber(entry.value);
        if (ftp !== undefined && ftp > 0) referenceFtp = ftp;
        else {
          diagnostics.warn(
            'bad-ftp',
            `FTP = ${entry.value} is not a power; kept in the extensions.`,
          );
          keptHeader.push(entry);
        }
      } else keptHeader.push(entry);
    }

    // Sections between consecutive points; the same minute twice is a jump, not a step.
    const sectionsOfCourse: {
      seconds: number;
      start: number;
      end: number;
      from: number;
      to: number;
    }[] = [];
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i];
      const b = points[i + 1];
      if (!a || !b) continue;
      const seconds = msRound(secondsOf(b.minute) - secondsOf(a.minute));
      if (seconds > 0) {
        sectionsOfCourse.push({
          seconds,
          start: a.value,
          end: b.value,
          from: secondsOf(a.minute),
          to: secondsOf(b.minute),
        });
      }
    }
    if (sectionsOfCourse.length === 0) {
      throw new ImportError(
        'too-few-points',
        'The course needs at least two points at different minutes.',
        'COURSE DATA',
      );
    }

    const steps: (Omit<WorkoutInterval, 'cues'> & { cues?: WorkoutCue[] })[] = sectionsOfCourse.map(
      (s, i) => ({
        kind: 'interval',
        id: String(i + 1),
        duration: { kind: 'time', seconds: s.seconds },
        effort: {
          kind: 'target',
          primary:
            s.start === s.end
              ? { unit, start: { low: s.start, high: s.start } }
              : {
                  unit,
                  start: { low: s.start, high: s.start },
                  end: { low: s.end, high: s.end },
                },
        },
      }),
    );

    // Course text: the cue belongs to the step it falls into, counted from that step's start.
    const unplaced: { line: string }[] = [];
    for (const { line, number } of textLines) {
      const cue = parseCue(line);
      if (!cue) {
        diagnostics.warn(
          'bad-course-text',
          `Line ${number} is not a course text; kept in the extensions.`,
          `line ${number}`,
        );
        unplaced.push({ line });
        continue;
      }
      const t = cue.offsetSeconds;
      let index = sectionsOfCourse.findIndex((s) => s.from <= t && t < s.to);
      if (index < 0) {
        const lastEnd = sectionsOfCourse[sectionsOfCourse.length - 1]?.to ?? 0;
        if (t >= lastEnd) {
          index = sectionsOfCourse.length - 1;
          if (t > lastEnd)
            diagnostics.warn(
              'cue-after-end',
              `The course text at ${t} s comes after the course ends.`,
              `line ${number}`,
            );
        } else {
          diagnostics.warn(
            'cue-before-start',
            `The course text at ${t} s comes before the course starts; kept in the extensions.`,
            `line ${number}`,
          );
          unplaced.push({ line });
          continue;
        }
      }
      const step = steps[index];
      const section = sectionsOfCourse[index];
      if (!step || !section) continue;
      step.cues = [...(step.cues ?? []), { ...cue, offsetSeconds: msRound(t - section.from) }];
    }

    const rebuilt = pointsOfSteps(sectionsOfCourse);
    const extension = compact({
      columns,
      header: keptHeader.length > 0 ? keptHeader : undefined,
      sections: sections.length > 0 ? sections : undefined,
      outside: outside.length > 0 ? outside : undefined,
      unplacedCourseText: unplaced.length > 0 ? unplaced : undefined,
      points: samePoints(rebuilt, points)
        ? undefined
        : points.map((p) => [p.minute, p.value] as [number, number]),
    });

    const title = name ?? baseName(options.fileName) ?? 'Untitled workout';
    if (name === undefined && baseName(options.fileName) === undefined) {
      diagnostics.warn(
        'missing-name',
        `The course has no FILE NAME; "${title}" is used.`,
        'COURSE HEADER',
      );
    }
    const workout: Workout = {
      format: 'ridrs-workout',
      version: 1,
      id: workoutId(options, title),
      name: title,
      ...(description ? { description } : {}),
      sport: 'ride',
      ...(referenceFtp === undefined ? {} : { referenceFtp }),
      source: sourceOf(format, options),
      steps,
      extensions: { [format]: extension },
    };
    return [workout];
  });
}

export const importErg: WorkoutImporter = (input, options) => importCourse('erg', input, options);
export const importMrc: WorkoutImporter = (input, options) => importCourse('mrc', input, options);
