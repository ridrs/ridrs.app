// SPDX-License-Identifier: AGPL-3.0-or-later

import type { WorkoutInterval, WorkoutRepeat, WorkoutTarget } from '@ridrs/contracts';
import { defaultPowerZones, type WorkoutMetrics } from '@ridrs/workout';
import { describe, expect, it } from 'vitest';
import {
  chartFallbackText,
  dayText,
  durationText,
  effortText,
  numbersOf,
  ownTargetText,
  repeatText,
  stepDurationText,
  stepMarks,
  stepName,
  targetText,
  zoneRowsOf,
} from './format.ts';
import { messages } from './i18n/index.ts';

const { en, de } = messages;

const target = (unit: WorkoutTarget['unit'], low: number, high = low, end?: [number, number]): WorkoutTarget => ({
  unit,
  start: { low, high },
  ...(end ? { end: { low: end[0], high: end[1] } } : {}),
});

const interval = (step: Partial<WorkoutInterval>): WorkoutInterval => ({
  kind: 'interval',
  id: '1',
  duration: { kind: 'time', seconds: 60 },
  effort: { kind: 'free' },
  ...step,
});

const metrics = (values: Partial<WorkoutMetrics>): WorkoutMetrics => ({
  durationSeconds: 3780,
  durationEstimated: false,
  intensityEstimated: false,
  basis: 'percent-ftp',
  secondsWithoutPowerTarget: 0,
  ergStepIds: [],
  ...values,
});

describe('durationText', () => {
  it.each([
    [3780, '1 h 3 min'],
    [7200, '2 h'],
    [720, '12 min'],
    [990, '16 min 30 s'],
    [45, '45 s'],
  ])('writes %i s as "%s"', (seconds, text) => expect(durationText(seconds)).toBe(text));
});

describe('targets in their own unit', () => {
  it('writes % FTP, a ramp and a range', () => {
    expect(ownTargetText(target('percent-ftp', 90), en)).toBe('90 % FTP');
    expect(ownTargetText(target('percent-ftp', 50, 50, [75, 75]), en)).toBe('50 → 75 % FTP');
    expect(ownTargetText(target('percent-ftp', 88, 94), en)).toBe('88–94 % FTP');
  });

  it('writes zones, heart rate, cadence and RPE in their units', () => {
    expect(ownTargetText(target('power-zone', 2), en)).toBe('Z2');
    expect(ownTargetText(target('power-zone', 2, 3), en)).toBe('Z2–Z3');
    expect(ownTargetText(target('hr-zone', 2), en)).toBe('HR Z2');
    expect(ownTargetText(target('hr-zone', 2), de)).toBe('HF Z2');
    expect(ownTargetText(target('bpm', 130, 140), en)).toBe('130–140 bpm');
    expect(ownTargetText(target('percent-lthr', 85), en)).toBe('85 % LTHR');
    expect(ownTargetText(target('rpm', 85, 95), en)).toBe('85–95 rpm');
    expect(ownTargetText(target('rpe', 6), en)).toBe('RPE 6');
  });

  it('takes the decimal mark of the language', () => {
    expect(ownTargetText(target('percent-ftp', 87.5), en)).toBe('87.5 % FTP');
    expect(ownTargetText(target('percent-ftp', 87.5), de)).toBe('87,5 % FTP');
  });
});

describe('targetText', () => {
  it('puts watts beside % with an FTP, and only then', () => {
    expect(targetText(target('percent-ftp', 90), { ftp: 250 }, en)).toBe('90 % FTP · 225 W');
    expect(targetText(target('percent-ftp', 50, 50, [75, 75]), { ftp: 250 }, en)).toBe(
      '50 → 75 % FTP · 125 → 188 W',
    );
    expect(targetText(target('percent-ftp', 90), {}, en)).toBe('90 % FTP');
  });

  it('leaves watts as watts and resolves a zone with the zones of the profile', () => {
    expect(targetText(target('watts', 150), { ftp: 250 }, en)).toBe('150 W');
    expect(
      targetText(target('power-zone', 2), { ftp: 200, powerZones: defaultPowerZones() }, en),
    ).toBe('Z2 · 110–150 W');
  });

  it('puts bpm beside % LTHR with an LTHR', () => {
    expect(targetText(target('percent-lthr', 90), { lthr: 170 }, en)).toBe('90 % LTHR · 153 bpm');
  });
});

describe('effortText', () => {
  it('joins the primary and the secondary targets', () => {
    const effort = {
      kind: 'target' as const,
      primary: target('percent-ftp', 90),
      secondary: [target('rpm', 85, 95)],
    };
    expect(effortText(effort, { ftp: 250 }, en)).toBe('90 % FTP · 225 W · 85–95 rpm');
  });

  it('names free ride and max effort', () => {
    expect(effortText({ kind: 'free' }, {}, en)).toBe('Free ride');
    expect(effortText({ kind: 'free' }, {}, de)).toBe('Freie Fahrt');
    expect(effortText({ kind: 'max-effort' }, {}, en)).toBe('Max effort');
  });
});

describe('stepDurationText', () => {
  it('writes every kind of length as the step states it', () => {
    expect(stepDurationText({ kind: 'time', seconds: 600 }, en)).toBe('10 min');
    expect(stepDurationText({ kind: 'distance', meters: 5000 }, en)).toBe('5 km');
    expect(stepDurationText({ kind: 'distance', meters: 2500 }, de)).toBe('2,5 km');
    expect(stepDurationText({ kind: 'distance', meters: 800 }, en)).toBe('800 m');
    expect(stepDurationText({ kind: 'energy', kilocalories: 300 }, en)).toBe('300 kcal');
    expect(stepDurationText({ kind: 'open' }, en)).toBe('until the lap button');
    expect(
      stepDurationText({ kind: 'until', unit: 'bpm', comparison: 'below', value: 110 }, en),
    ).toBe('until heart rate below 110 bpm');
    expect(
      stepDurationText({ kind: 'until', unit: 'watts', comparison: 'above', value: 300 }, de),
    ).toBe('bis Leistung über 300 W');
  });
});

describe('stepMarks', () => {
  it('marks heart rate targets and lengths other than time (F5)', () => {
    expect(stepMarks(interval({ effort: { kind: 'target', primary: target('bpm', 130) } }))).toEqual([
      'heart-rate',
    ]);
    expect(stepMarks(interval({ duration: { kind: 'distance', meters: 5000 } }))).toEqual(['distance']);
    expect(stepMarks(interval({ duration: { kind: 'open' } }))).toEqual(['open']);
    expect(
      stepMarks(
        interval({
          duration: { kind: 'until', unit: 'bpm', comparison: 'below', value: 110 },
          effort: { kind: 'target', primary: target('hr-zone', 2) },
        }),
      ),
    ).toEqual(['heart-rate', 'until']);
    expect(stepMarks(interval({ effort: { kind: 'target', primary: target('watts', 200) } }))).toEqual([]);
  });
});

describe('stepName and repeatText', () => {
  it('prefers the name, else the intensity', () => {
    expect(stepName(interval({ name: 'Sweet spot', intensity: 'interval' }), en)).toBe('Sweet spot');
    expect(stepName(interval({ intensity: 'warm-up' }), de)).toBe('Aufwärmen');
    expect(stepName(interval({}), en)).toBe('Step');
  });

  it('writes how a repeat ends', () => {
    const repeat = (until: WorkoutRepeat['until']): WorkoutRepeat => ({ kind: 'repeat', id: '2', until, steps: [] });
    expect(repeatText(repeat({ kind: 'count', reps: 3 }), en)).toBe('3×');
    expect(repeatText(repeat({ kind: 'time', seconds: 1200 }), en)).toBe('Repeat for 20 min');
    expect(
      repeatText(repeat({ kind: 'condition', unit: 'bpm', comparison: 'above', value: 150 }), en),
    ).toBe('Repeat until heart rate above 150 bpm');
  });
});

describe('numbersOf', () => {
  it('rounds the load and the work and writes IF with two decimals', () => {
    expect(
      numbersOf(metrics({ trainingLoad: 68.56, intensityFactor: 0.808, kilojoules: 720 }), en),
    ).toEqual([
      ['Duration', '1 h 3 min'],
      ['TSS', '69'],
      ['IF', '0.81'],
      ['Work', '720 kJ'],
    ]);
  });

  it('marks estimated numbers and shows a dash where the profile lacks a value', () => {
    expect(
      numbersOf(
        metrics({ durationSeconds: 3000, durationEstimated: true, intensityEstimated: true, intensityFactor: 0.6436 }),
        de,
      ),
    ).toEqual([
      ['Dauer', '≈ 50 min'],
      ['TSS', '–'],
      ['IF', '≈ 0,64'],
      ['Arbeit', '–'],
    ]);
  });

  it('marks only the numbers, not the duration, when only the intensity is assumed', () => {
    expect(numbersOf(metrics({ intensityEstimated: true, trainingLoad: 40 }), en).slice(0, 2)).toEqual([
      ['Duration', '1 h 3 min'],
      ['TSS', '≈ 40'],
    ]);
  });
});

describe('zoneRowsOf', () => {
  it('lists every zone with its time, a dash for none, and the time without a power target', () => {
    const rows = zoneRowsOf(
      metrics({ timeInZones: [990, 0, 2160], secondsWithoutPowerTarget: 300 }),
      [{ name: 'Easy', upTo: 55 }, { upTo: 75 }, { name: 'Hard' }],
      en,
    );
    expect(rows).toEqual([
      ['Z1 Easy', '16 min 30 s'],
      ['Z2', '–'],
      ['Z3 Hard', '36 min'],
      ['Without a power target', '5 min'],
    ]);
  });

  it('gives no zones without an FTP (no time per zone)', () => {
    expect(zoneRowsOf(metrics({}), defaultPowerZones(), en)).toBeUndefined();
  });
});

describe('chartFallbackText and dayText', () => {
  it('stands in for the chart with the duration and the load', () => {
    expect(chartFallbackText(metrics({ trainingLoad: 68.56 }), en)).toBe('1 h 3 min · 69 TSS');
    expect(chartFallbackText(metrics({}), en)).toBe('1 h 3 min');
  });

  it('writes a planned day in the language', () => {
    expect(dayText('2026-11-12', en)).toBe('Thu 12 Nov');
    expect(dayText('2026-11-12', de)).toBe('Do. 12. Nov.');
  });
});
