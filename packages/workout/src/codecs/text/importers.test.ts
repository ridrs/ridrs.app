// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { decodeText, fractionToPercent, slugify } from './common.ts';
import { pointsOfSteps } from './course.ts';
import { importErg, importIntervalsText, importMrc, importTcx, importZwo } from './index.ts';

const utf16 = (text: string, little: boolean): Uint8Array => {
  const bytes = new Uint8Array(2 + text.length * 2);
  bytes.set(little ? [0xff, 0xfe] : [0xfe, 0xff]);
  [...text].forEach((c, i) => {
    const code = c.charCodeAt(0);
    bytes.set(little ? [code & 0xff, code >> 8] : [code >> 8, code & 0xff], 2 + i * 2);
  });
  return bytes;
};

const ZWO =
  '<workout_file><name>Über Ride</name><workout><SteadyState Duration="60" Power="0.5"/></workout></workout_file>';

describe('decoding and metadata', () => {
  it('lets the byte order mark choose UTF-8 or UTF-16', () => {
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe('a');
    expect(decodeText(utf16('ä', true))).toBe('ä');
    expect(decodeText(utf16('ä', false))).toBe('ä');
    expect(decodeText('﻿x')).toBe('x');
  });

  it('imports UTF-16 files of every text format', () => {
    for (const little of [true, false]) {
      const result = importZwo(utf16(ZWO, little));
      expect(result.ok && result.workouts[0]?.name).toBe('Über Ride');
    }
  });

  it('derives the id from the options, the file name or the name, never at random', () => {
    const id = (options?: Parameters<typeof importZwo>[1]) => {
      const result = importZwo(ZWO, options);
      return result.ok ? result.workouts[0]?.id : undefined;
    };
    expect(id({ id: 'mine' })).toBe('mine');
    expect(id({ fileName: 'My Ride (v2).zwo' })).toBe('my-ride-v2');
    expect(id()).toBe('uber-ride');
    expect(slugify('Ünï  cödé!')).toBe('uni-code');
  });

  it('records the source from the options and leaves out what it was not given', () => {
    const result = importZwo(ZWO, {
      fileName: 'a.zwo',
      importedAt: '2026-01-02T03:04:05.000Z',
      originalHash: 'abc',
      sourceKind: 'builtin',
    });
    expect(result.ok && result.workouts[0]?.source).toEqual({
      kind: 'builtin',
      format: 'zwo',
      fileName: 'a.zwo',
      originalHash: 'abc',
      importedAt: '2026-01-02T03:04:05.000Z',
    });
    const bare = importZwo(ZWO);
    expect(bare.ok && bare.workouts[0]?.source).toEqual({ kind: 'imported', format: 'zwo' });
  });
});

describe('ZWO', () => {
  it('turns fractions into percent without float noise', () => {
    expect(fractionToPercent('0.07')).toBe(7);
    expect(fractionToPercent('0.29')).toBe(29);
    expect(fractionToPercent('1.2')).toBe(120);
    expect(fractionToPercent('1e-1')).toBe(10);
  });

  it('refuses every sport but cycling, with the code not-cycling', () => {
    for (const sport of ['run', 'swim', 'strength']) {
      const result = importZwo(
        `<workout_file><name>x</name><sportType>${sport}</sportType><workout/></workout_file>`,
      );
      expect(result.ok).toBe(false);
      expect(result.diagnostics.map((d) => d.code)).toContain('not-cycling');
    }
  });

  it('reads the elements case-insensitively and keeps their spelling', () => {
    const result = importZwo(
      '<workout_file><name>x</name><workout><steadystate duration="60" power="0.5"/></workout></workout_file>',
    );
    expect(result.ok && result.workouts[0]?.steps[0]?.extensions).toEqual({
      zwo: { element: 'steadystate', attributeOrder: ['duration', 'power'] },
    });
  });

  it('keeps a cadence range with one end only, and says so', () => {
    const result = importZwo(
      '<workout_file><name>x</name><workout><SteadyState Duration="60" Power="0.5" CadenceLow="80"/></workout></workout_file>',
    );
    expect(result.ok && result.workouts[0]?.steps[0]?.extensions).toEqual({
      zwo: {
        element: 'SteadyState',
        attributeOrder: ['Duration', 'Power', 'CadenceLow'],
        attributes: { CadenceLow: '80' },
      },
    });
    expect(result.diagnostics.map((d) => d.code)).toContain('unpaired-cadence-range');
  });
});

describe('ERG and MRC', () => {
  const course = (unit: string, rows: string) =>
    `[COURSE HEADER]\nMINUTES ${unit}\n[END COURSE HEADER]\n[COURSE DATA]\n${rows}\n[END COURSE DATA]\n`;

  it('rebuilds the points exactly from the steps', () => {
    const result = importErg(course('WATTS', '0 100\n5 100\n5 200\n10 250\n10 120\n12.5 120'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const steps = result.workouts[0]?.steps ?? [];
    expect(steps).toHaveLength(3);
    // The last jump (10, 250 -> 10, 120) is the start of the third step: no points are kept.
    expect(result.workouts[0]?.extensions).toEqual({ erg: { columns: 'MINUTES WATTS' } });
    expect(
      pointsOfSteps([
        { seconds: 300, start: 100, end: 100 },
        { seconds: 300, start: 200, end: 250 },
        { seconds: 150, start: 120, end: 120 },
      ]),
    ).toEqual([
      [0, 100],
      [5, 100],
      [5, 200],
      [10, 250],
      [10, 120],
      [12.5, 120],
    ]);
  });

  it('keeps ERG in watts and MRC in percent, whatever the numbers', () => {
    const erg = importErg(course('WATTS', '0 80\n1 80'));
    const mrc = importMrc(course('PERCENT', '0 80\n1 80'));
    const unit = (r: typeof erg) =>
      r.ok &&
      r.workouts[0]?.steps[0]?.kind === 'interval' &&
      (r.workouts[0].steps[0].effort as { primary: { unit: string } }).primary.unit;
    expect(unit(erg)).toBe('watts');
    expect(unit(mrc)).toBe('percent-ftp');
  });

  it('does not lose float minutes: 10.1 minutes are 606 seconds', () => {
    const result = importMrc(course('PERCENT', '0 50\n10.1 50'));
    expect(result.ok && result.workouts[0]?.steps[0]).toMatchObject({
      duration: { kind: 'time', seconds: 606 },
    });
  });
});

describe('TCX', () => {
  it('refuses a file that is not TCX', () => {
    const result = importTcx('<recipe/>');
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain('not-tcx');
  });
});

describe('intervals.icu text', () => {
  const one = (text: string) => {
    const result = importIntervalsText(text, { fileName: 'x.txt' });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    return result.ok ? (result.workouts[0]?.steps ?? []) : [];
  };

  it('reads the duration forms', () => {
    const seconds = (text: string) => {
      const [step] = one(`- ${text} 50%`);
      return step?.kind === 'interval' ? step.duration : undefined;
    };
    expect(seconds('30s')).toEqual({ kind: 'time', seconds: 30 });
    expect(seconds('10m')).toEqual({ kind: 'time', seconds: 600 });
    expect(seconds('1m30')).toEqual({ kind: 'time', seconds: 90 });
    expect(seconds('1h30m')).toEqual({ kind: 'time', seconds: 5400 });
    expect(seconds('5m30s')).toEqual({ kind: 'time', seconds: 330 });
    expect(seconds('4.5mi')).toEqual({ kind: 'distance', meters: 7242.048 });
    expect(seconds('500mtr')).toEqual({ kind: 'distance', meters: 500 });
  });

  it('keeps a falling ramp falling and a range a range', () => {
    const [ramp, range] = one('- 10m ramp 80-60%\n- 10m 80-60%');
    expect(ramp?.kind === 'interval' && ramp.effort).toMatchObject({
      primary: { start: { low: 80, high: 80 }, end: { low: 60, high: 60 } },
    });
    expect(range?.kind === 'interval' && range.effort).toMatchObject({
      primary: { start: { low: 80, high: 60 } },
    });
  });

  it('refuses text with pace targets as not cycling', () => {
    const result = importIntervalsText('- 10m 5:00/km');
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain('not-cycling');
  });
});
