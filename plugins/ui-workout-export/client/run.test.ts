// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Workout } from '@ridrs/contracts';
import { importIntervalsText } from '@ridrs/workout';
import { describe, expect, it } from 'vitest';
import { en } from './i18n/en.ts';
import { EXPORT_FORMATS, fileNameOf, prepareExport, subjectOf } from './run.ts';

const workout = (text: string, name = 'Sweet Spot 3×12 (Übung)'): Workout => {
  const result = importIntervalsText(text, { id: 'w', fileName: 'w.txt' });
  if (!result.ok) throw new Error('refused');
  return { ...(result.workouts[0] as Workout), name };
};

describe('fileNameOf', () => {
  it('writes an ASCII name with the format’s extension', () => {
    expect(fileNameOf(workout('- 5m 50%'), 'zwo')).toBe('sweet-spot-3-12-ubung.zwo');
    expect(fileNameOf(workout('- 5m 50%', '***'), 'intervals')).toBe('workout.txt');
  });
});

describe('prepareExport', () => {
  const watts = workout('- 10m 200w');

  it('gives the file as base64 with its media type, and the warnings', () => {
    const prepared = prepareExport(watts, 'zwo', 250);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.mediaType).toBe('application/xml');
    expect(atob(prepared.data)).toContain('Power="0.8"');
    expect(prepared.warnings.map((w) => w.code)).toContain('watts-to-percent');
  });

  it('refuses where an FTP is missing, with the reason', () => {
    const prepared = prepareExport(watts, 'zwo', undefined);
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.reason[0]?.code).toBe('ftp-required');
  });

  it('prepares every format, FIT as bytes', () => {
    for (const format of EXPORT_FORMATS) expect(prepareExport(watts, format, 250).ok).toBe(true);
    const fit = prepareExport(watts, 'fit', undefined);
    if (!fit.ok) throw new Error('refused');
    expect(atob(fit.data).slice(8, 12)).toBe('.FIT');
  });

  it('has a text for every warning an export gives', () => {
    const everything = workout('3x\n- 1m 100% 90rpm\n- 1m 140bpm\n- press lap 60%\n- 10m ramp 50-75%');
    const codes = new Set<string>();
    for (const format of EXPORT_FORMATS) {
      const prepared = prepareExport(everything, format, 250);
      if (prepared.ok) for (const w of prepared.warnings) codes.add(w.code);
    }
    expect([...codes].filter((code) => !(code in en.warnings))).toEqual([]);
  });
});

describe('subjectOf', () => {
  it('is loading until the library is there, then missing for an unknown workout', () => {
    expect(subjectOf({ from: 'lib', workoutId: 'x' }, new Map()).state).toBe('loading');
    const library = { provider: 'lib', label: 'L', status: 'ready', writable: false, data: { workouts: [] } };
    expect(subjectOf({ from: 'lib', workoutId: 'x' }, new Map([['lib', library]]) as never).state).toBe('missing');
  });
});
