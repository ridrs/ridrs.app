// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  Workout,
  WorkoutInterval,
  WorkoutSourceFormat,
  WorkoutTarget,
} from '@ridrs/contracts';
import { pointsOfSteps } from '../text/course.ts';
import { num, record } from './common.ts';
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

/**
 * ERG and MRC course files, the form `importErg` and `importMrc` read: `[COURSE HEADER]`,
 * `[COURSE DATA]` with `minute value` points and `[COURSE TEXT]`. ERG holds watts and MRC percent
 * of FTP: a workout in the other unit is converted with the FTP, and a course file has no
 * repeats, cadence, heart rate or free ride: repeats are written out, cadence is dropped, and a
 * step without a power target holds the last power. A file that says in its column line that it
 * holds the other unit keeps it (`extensions.erg` or `.mrc`).
 */

interface Section {
  seconds: number;
  start: number;
  end: number;
}

const msRound = (seconds: number): number => Math.round(seconds * 1000) / 1000;

/** A minute as the files write it: two decimals where they are exact to the millisecond. */
function minuteText(seconds: number): string {
  const target = msRound(seconds);
  for (let places = 2; places <= 8; places += 1) {
    const text = (seconds / 60).toFixed(places);
    if (msRound(Number(text) * 60) === target) return text;
  }
  return (seconds / 60).toFixed(8);
}

/** The sections between the points of an extension, as the importer derives them. */
function sectionsOfPoints(points: unknown): Section[] | undefined {
  if (!Array.isArray(points)) return undefined;
  const sections: Section[] = [];
  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    if (!Array.isArray(a) || !Array.isArray(b)) return undefined;
    const seconds = msRound(msRound(Number(b[0]) * 60) - msRound(Number(a[0]) * 60));
    if (seconds > 0) sections.push({ seconds, start: Number(a[1]), end: Number(b[1]) });
  }
  return sections;
}

/** Where the first section starts, in seconds: course text counts from minute 0 of the points. */
function firstSectionStart(points: unknown): number {
  if (!Array.isArray(points)) return 0;
  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    if (Array.isArray(a) && Array.isArray(b) && Number(b[0]) > Number(a[0]))
      return msRound(Number(a[0]) * 60);
  }
  return 0;
}

const sameSections = (a: readonly Section[], b: readonly Section[]): boolean =>
  a.length === b.length &&
  a.every((s, i) => {
    const t = b[i];
    return (
      t !== undefined &&
      Math.abs(s.seconds - t.seconds) < 0.0005 &&
      s.start === t.start &&
      s.end === t.end
    );
  });

const columnUnit = (line: unknown): 'watts' | 'percent-ftp' | undefined => {
  if (typeof line !== 'string') return undefined;
  const word = /^minutes\s+(\S+)/i.exec(line)?.[1]?.toLowerCase();
  return word === 'watts'
    ? 'watts'
    : word === 'percent' || word === '%' || word === 'ftp'
      ? 'percent-ftp'
      : undefined;
};

function exportCourse(
  format: Extract<WorkoutSourceFormat, 'erg' | 'mrc'>,
  workout: Workout,
  options: WorkoutExportOptions,
): WorkoutExport<string> {
  const notes = new Notes();
  const power = new PowerConverter(options, notes);
  const extension = extensionOf(workout, format);
  const label = format.toUpperCase();

  const hasRepeat = workout.steps.some((s) => s.kind === 'repeat');
  const steps = unroll(workout.steps, notes, format);
  if (hasRepeat)
    notes.warn('repeats-unrolled', `${label} has no repeats; every round is written out.`);

  // The unit: the format's own, unless the file said otherwise and the targets agree.
  const native = format === 'erg' ? 'watts' : 'percent-ftp';
  const said = columnUnit(extension?.columns);
  const primaries = steps.flatMap((s) => primaryOf(s) ?? []).filter((t) => POWER_UNITS.has(t.unit));
  const unit =
    said && said !== native && primaries.length > 0 && primaries.every((t) => t.unit === said)
      ? said
      : native;
  const convert = (target: WorkoutTarget, range: WorkoutTarget['start'], at: string) =>
    unit === 'watts' ? power.watts(range, target.unit, at) : power.percent(range, target.unit, at);
  const value = (n: number): number =>
    unit === 'watts' ? Math.round(n) : Math.round(n * 100) / 100;

  const draft: { seconds: number; start?: number; end?: number; step: WorkoutInterval }[] = [];
  for (const step of steps) {
    const at = placeOf(step);
    const seconds = secondsOf(step, notes, format);
    const target = primaryOf(step);
    const targets = [...(target ? [target] : []), ...secondaryOf(step)];
    if (targets.some((t) => t.unit === 'rpm')) {
      notes.warn('cadence-dropped', `${at}: ${label} has no cadence; it is not written.`, step.id);
    }
    if (targets.some((t) => t.unit !== 'rpm' && t !== target)) {
      notes.warn(
        'secondary-dropped',
        `${at}: a second target cannot be written in ${label}.`,
        step.id,
      );
    }
    let start: number | undefined;
    let end: number | undefined;
    if (target && POWER_UNITS.has(target.unit)) {
      const from = convert(target, target.start, at) ?? { low: 0, high: 0 };
      const to = target.end ? (convert(target, target.end, at) ?? { low: 0, high: 0 }) : undefined;
      if (from.low !== from.high || (to && to.low !== to.high)) {
        notes.warn(
          'range-to-middle',
          `${at}: a range is written as its middle; ${label} holds one value.`,
          step.id,
        );
      }
      start = value(middle(from));
      end = to ? value(middle(to)) : start;
    } else if (target && target.unit !== 'rpm') {
      notes.warn(
        'target-held',
        `${at}: a target in ${target.unit} cannot be written in ${label}; the step holds the last power.`,
        step.id,
      );
    } else {
      notes.warn(
        'target-held',
        `${at}: a step without a power target holds the last power in ${label}.`,
        step.id,
      );
    }
    draft.push({
      seconds,
      ...(start === undefined ? {} : { start }),
      ...(end === undefined ? {} : { end }),
      step,
    });
  }
  // A step without a power holds the one before it, or the first one there is.
  let held: number | undefined;
  const firstPower = draft.find((d) => d.start !== undefined)?.start;
  const sections: Section[] = draft.map((d) => {
    const start = d.start ?? held ?? firstPower;
    const end = d.end ?? start;
    held = end ?? held;
    return { seconds: d.seconds, start: start ?? 0, end: end ?? 0 };
  });
  if (draft.length > 0 && firstPower === undefined) {
    notes.warn('no-power', `${label} needs at least one step with a power target.`);
  }

  return finishExport(format, notes, () => {
    const fromExtension = sectionsOfPoints(extension?.points);
    const points =
      fromExtension && sameSections(fromExtension, sections)
        ? (extension?.points as [number, number][])
        : pointsOfSteps(sections);

    const lines: string[] = ['[COURSE HEADER]'];
    for (const entry of Array.isArray(extension?.header) ? extension.header : []) {
      const item = record(entry);
      if (typeof item?.key === 'string') lines.push(`${item.key} = ${String(item.value ?? '')}`);
      else if (typeof item?.raw === 'string') lines.push(item.raw);
    }
    const oneLine = (text: string) => text.replace(/\s*[\r\n]+\s*/g, ' ');
    if (workout.description) lines.push(`DESCRIPTION = ${oneLine(workout.description)}`);
    lines.push(`FILE NAME = ${oneLine(workout.name)}`);
    const ftp =
      workout.referenceFtp ?? (primaries.some((t) => t.unit !== unit) ? options.ftp : undefined);
    if (ftp !== undefined) lines.push(`FTP = ${num(ftp)}`);
    const said =
      typeof extension?.columns === 'string' && columnUnit(extension.columns) === unit
        ? extension.columns
        : undefined;
    // A file that had no column line has none again, as long as its unit is the format's own.
    if (said !== undefined || extension === undefined || unit !== native) {
      lines.push(said ?? (unit === 'watts' ? 'MINUTES WATTS' : 'MINUTES PERCENT'));
    }
    lines.push('[END COURSE HEADER]', '[COURSE DATA]');
    for (const [minute, v] of points) {
      lines.push(
        `${Number.isInteger(minute * 100) ? minute.toFixed(2) : minuteText(msRound(minute * 60))}\t${num(v)}`,
      );
    }
    lines.push('[END COURSE DATA]');

    const text: string[] = [];
    for (const entry of Array.isArray(extension?.unplacedCourseText)
      ? extension.unplacedCourseText
      : []) {
      const line = record(entry)?.line;
      if (typeof line === 'string') text.push(line);
    }
    let at = fromExtension && points === extension?.points ? firstSectionStart(points) : 0;
    draft.forEach((d, i) => {
      for (const cue of d.step.cues ?? []) {
        const clean = cue.text.replace(/[\t\r\n]+/g, ' ');
        text.push(
          `${num(msRound(at + cue.offsetSeconds))}\t${clean}${cue.durationSeconds === undefined ? '' : `\t${num(cue.durationSeconds)}`}`,
        );
      }
      at = msRound(at + (sections[i]?.seconds ?? 0));
    });
    if (text.length > 0) lines.push('[COURSE TEXT]', ...text, '[END COURSE TEXT]');
    for (const section of Array.isArray(extension?.sections) ? extension.sections : []) {
      const item = record(section);
      if (typeof item?.name !== 'string') continue;
      lines.push(
        `[${item.name}]`,
        ...(Array.isArray(item.lines) ? item.lines.map(String) : []),
        `[END ${item.name}]`,
      );
    }
    for (const line of Array.isArray(extension?.outside) ? extension.outside : [])
      lines.push(String(line));
    return `${lines.join('\n')}\n`;
  });
}

export const exportErg = (
  workout: Workout,
  options: WorkoutExportOptions = {},
): WorkoutExport<string> => exportCourse('erg', workout, options);
export const exportMrc = (
  workout: Workout,
  options: WorkoutExportOptions = {},
): WorkoutExport<string> => exportCourse('mrc', workout, options);
