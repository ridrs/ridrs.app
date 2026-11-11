// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type Workout, type WorkoutStep, workoutSchema } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import type { WorkoutImporter, WorkoutImportResult } from '../../codec.ts';
import { fractionToPercent, parseNumber } from './common.ts';
import { pointsOfSteps } from './course.ts';
import { importErg, importIntervalsText, importMrc, importTcx, importZwo } from './index.ts';
import { isElement, parseXml, type XmlElement } from './xml.ts';

/** Where the test vectors are and how a test imports one: shared by the tests of this folder. */
const VECTORS_DIR = resolve(import.meta.dirname, '../../../test-vectors');

const IMPORTERS: Record<string, WorkoutImporter> = {
  zwo: importZwo,
  erg: importErg,
  mrc: importMrc,
  tcx: importTcx,
  intervals: importIntervalsText,
};

const vectorsOf = (format: string): string[] =>
  readdirSync(join(VECTORS_DIR, format))
    .filter((f) => !f.endsWith('.golden.json') && f !== 'README.md')
    .sort();

const readVector = (format: string, file: string): Buffer =>
  readFileSync(join(VECTORS_DIR, format, file));

const importVector = (format: string, file: string): WorkoutImportResult => {
  const bytes = readVector(format, file);
  return (IMPORTERS[format] as WorkoutImporter)(new Uint8Array(bytes), {
    fileName: file,
    importedAt: '2026-11-11T12:00:00.000Z',
    originalHash: createHash('sha256').update(bytes).digest('hex'),
  });
};
/**
 * Every file of `test-vectors/<format>/` is imported and compared with its golden file
 * `<file>.golden.json`, which was checked by hand against the source. `UPDATE_GOLDEN=1` rewrites
 * the golden files (then read the diff, and format them with `pnpm format`).
 */

/** The golden form of a result: the English messages are not part of it. */
const golden = (result: WorkoutImportResult) => ({
  ok: result.ok,
  ...(result.ok ? { workouts: result.workouts } : {}),
  diagnostics: result.diagnostics.map(({ severity, code, at }) => ({
    severity,
    code,
    ...(at === undefined ? {} : { at }),
  })),
});

describe.each(Object.keys(IMPORTERS))('test vectors: %s', (format) => {
  it.each(vectorsOf(format))('%s matches its golden file', (file) => {
    const result = importVector(format, file);
    const path = join(VECTORS_DIR, format, `${file}.golden.json`);
    const actual = JSON.parse(JSON.stringify(golden(result)));
    if (process.env.UPDATE_GOLDEN) writeFileSync(path, `${JSON.stringify(actual, null, 2)}\n`);
    expect(actual).toEqual(JSON.parse(readFileSync(path, 'utf8')));
  });

  it.each(vectorsOf(format))(
    '%s gives workouts the schema accepts, the same every time',
    (file) => {
      const result = importVector(format, file);
      if (result.ok) {
        for (const workout of result.workouts)
          expect(workoutSchema.safeParse(workout).success).toBe(true);
      } else {
        expect(result.diagnostics.some((d) => d.severity === 'error')).toBe(true);
      }
      expect(importVector(format, file)).toEqual(result);
    },
  );
});

/**
 * "Nothing dropped": every attribute value and text of an XML source, every header, text and line
 * of a text source is either mapped to the typed model or kept in `extensions`. The checks are
 * deliberately independent of the importers' own bookkeeping: they read the source again.
 */

const ALIASES: Record<string, string> = {
  resting: 'rest',
  biking: 'ride',
  bike: 'ride',
  warmup: 'warm-up',
  cooldown: 'cool-down',
};

const factsOf = (element: XmlElement, path = element.name): { path: string; value: string }[] => [
  ...Object.entries(element.attributes).map(([name, value]) => ({
    path: `${path}@${name}`,
    value,
  })),
  ...element.children.flatMap((node) => {
    if (isElement(node)) return factsOf(node, `${path}/${node.name}`);
    return 'text' in node && node.text.trim() ? [{ path, value: node.text.trim() }] : [];
  }),
];

/** The values of an XML source that neither the typed model nor the extensions hold. */
function unaccountedXml(source: string, workouts: readonly Workout[]): string[] {
  const hay = JSON.stringify(workouts).toLowerCase();
  const holds = (value: string): boolean => {
    const v = value.toLowerCase();
    if (ALIASES[v] && hay.includes(ALIASES[v])) return true;
    const n = parseNumber(value);
    if (n === undefined) return hay.includes(v.replace(/\\/g, '\\\\').replace(/"/g, '\\"'));
    const candidates = [n, fractionToPercent(value)].filter((x) => x !== undefined);
    const numeric = candidates.some((c) => new RegExp(`(?<![\\d.])${c}(?![\\d.])`).test(hay));
    return numeric || ((value === '0' || value === '1') && /true|false/.test(hay));
  };
  return factsOf(parseXml(source))
    .filter(({ value }) => !holds(value))
    .map(({ path, value }) => `${path} = ${value}`);
}

describe('nothing dropped: XML sources', () => {
  for (const format of ['zwo', 'tcx']) {
    it.each(vectorsOf(format))(`${format}: %s`, (file) => {
      const result = importVector(format, file);
      if (!result.ok) return;
      const source = readVector(format, file).toString('utf8');
      // A skipped workout (not cycling) is refused on purpose and is not in the result.
      const skipped = result.diagnostics.some((d) => d.code === 'not-cycling');
      if (skipped) return;
      expect(unaccountedXml(source, result.workouts)).toEqual([]);
    });
  }

  it('finds a value the typed model and the extensions lack', () => {
    const result = importVector('zwo', 'sweet-spot-3x12.zwo');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const source = readVector('zwo', 'sweet-spot-3x12.zwo')
      .toString('utf8')
      .replace('Power="0.9"', 'Power="0.9" Hidden="yes-this-is-new"');
    expect(unaccountedXml(source, result.workouts)).toEqual([
      'workout_file/workout/SteadyState@Hidden = yes-this-is-new',
    ]);
  });
});

describe('nothing dropped: ERG and MRC', () => {
  for (const format of ['erg', 'mrc']) {
    it.each(vectorsOf(format))(`${format}: %s`, (file) => {
      const result = importVector(format, file);
      if (!result.ok) return;
      const [workout] = result.workouts;
      expect(workout).toBeDefined();
      if (!workout) return;
      const extension = (workout.extensions?.[format as 'erg' | 'mrc'] ?? {}) as {
        columns?: string;
        header?: ({ key: string; value: string } | { raw: string })[];
        sections?: { name: string; lines: string[] }[];
        outside?: string[];
        unplacedCourseText?: { line: string }[];
        points?: [number, number][];
      };
      const text = readVector(format, file)
        .toString('utf8')
        .split(/\r\n|\r|\n/)
        .map((l) => l.trim());
      let section = '';
      const points: [number, number][] = [];
      for (const line of text) {
        if (line === '') continue;
        const marker = /^\[(.+)\]$/.exec(line);
        if (marker) {
          section = (marker[1] ?? '').startsWith('END ') ? '' : (marker[1] ?? '').toUpperCase();
          continue;
        }
        if (section === 'COURSE HEADER') {
          const pair = /^([^=]+?)\s*=\s*(.*)$/.exec(line);
          if (!pair) {
            const kept = /^minutes\b/i.test(line)
              ? extension.columns === line
              : extension.header?.some((h) => 'raw' in h && h.raw === line);
            expect(kept, `header line "${line}"`).toBe(true);
            continue;
          }
          const key = (pair[1] ?? '').trim().toUpperCase();
          const value = pair[2] ?? '';
          const mapped =
            (key === 'FILE NAME' && workout.name === value) ||
            (key === 'DESCRIPTION' && workout.description === value) ||
            (key === 'FTP' && workout.referenceFtp === Number(value));
          const kept = extension.header?.some(
            (h) => 'key' in h && h.key.toUpperCase() === key && h.value === value,
          );
          expect(mapped || kept, `header line "${line}"`).toBe(true);
        } else if (section === 'COURSE DATA') {
          const [minute, value] = line.split(/\s+/).map(Number);
          points.push([minute as number, value as number]);
        } else if (section === 'COURSE TEXT') {
          const cued = workout.steps.some(
            (s) => s.kind === 'interval' && s.cues?.some((c) => line.includes(c.text)),
          );
          const kept = extension.unplacedCourseText?.some((u) => u.line === line);
          expect(cued || kept, `course text "${line}"`).toBe(true);
        } else if (section === '') {
          expect(extension.outside?.includes(line), `outside line "${line}"`).toBe(true);
        } else {
          expect(
            extension.sections?.some((s) => s.lines.includes(line)),
            `line "${line}" of ${section}`,
          ).toBe(true);
        }
      }
      // The points: rebuilt from the steps, or kept as they are.
      const rebuilt = pointsOfSteps(
        workout.steps.flatMap((s) => {
          if (s.kind !== 'interval' || s.effort.kind !== 'target') return [];
          const { primary } = s.effort;
          return [
            {
              seconds: s.duration.kind === 'time' ? s.duration.seconds : 0,
              start: primary.start.low,
              end: (primary.end ?? primary.start).low,
            },
          ];
        }),
      );
      const same =
        rebuilt.length === points.length &&
        rebuilt.every(
          ([m, v], i) => Math.abs(m - (points[i]?.[0] ?? NaN)) < 1e-6 && v === points[i]?.[1],
        );
      expect(same || extension.points?.length === points.length, 'the points').toBe(true);
    });
  }
});

describe('nothing dropped: intervals.icu text', () => {
  const KEYWORDS = new Set(['ramp', 'freeride', 'free', 'maxeffort', 'intensity', 'mtr']);
  it.each(vectorsOf('intervals'))('%s', (file) => {
    const result = importVector('intervals', file);
    if (!result.ok) return;
    const [workout] = result.workouts;
    if (!workout) return;
    const hay = JSON.stringify(workout).toLowerCase();
    const lines = readVector('intervals', file)
      .toString('utf8')
      .split(/\r\n|\r|\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    // Every line is a step, a repeat header or a plain line, and nothing else.
    const count = (steps: readonly WorkoutStep[]): number =>
      steps.reduce((n, s) => n + (s.kind === 'repeat' ? 1 + count(s.steps) : 1), 0);
    const plain = (workout.extensions?.intervals as { lines?: unknown[] } | undefined)?.lines ?? [];
    expect(count(workout.steps) + plain.length).toBe(lines.length);
    // Every word of the text is somewhere: a name, a note, a cue, a plain line or a kept line.
    for (const line of lines) {
      for (const word of line.match(/[A-Za-z]{3,}/g) ?? []) {
        const w = word.toLowerCase();
        if (KEYWORDS.has(w)) continue;
        const unit = ['rpm', 'bpm', 'lthr', 'ftp', 'rpe', 'mmp'].includes(w);
        expect(unit || hay.includes(w), `"${word}" of "${line}"`).toBe(true);
      }
    }
  });
});
