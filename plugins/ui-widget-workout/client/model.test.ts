// SPDX-License-Identifier: AGPL-3.0-or-later

import type { WorkoutEffort } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import {
  cadenceOf,
  clock,
  countdownAt,
  cueAt,
  inkOn,
  effortLevel,
  effortOf,
  elapsedSeconds,
  rangeText,
  spanOf,
  vivid,
  zoneColour,
} from './model.ts';

const watts = (low: number, high = low, end?: number): WorkoutEffort => ({
  kind: 'target',
  primary: { unit: 'watts', start: { low, high }, ...(end === undefined ? {} : { end: { low: end, high: end } }) },
});

describe('clock', () => {
  it('reads minutes and seconds, and hours when there are some', () => {
    expect(clock(240)).toBe('4:00');
    expect(clock(107)).toBe('1:47');
    expect(clock(3723)).toBe('1:02:03');
    // A fraction of a second left is still that second.
    expect(clock(2.2)).toBe('0:03');
    expect(clock(-4)).toBe('0:00');
  });
});

describe('the target of a step', () => {
  it('shows watts with % beside them when the FTP is known', () => {
    expect(effortOf(watts(288), 250)).toEqual({ kind: 'power', watts: '288', percent: '115' });
    expect(effortOf(watts(125), 250)).toEqual({ kind: 'power', watts: '125', percent: '50' });
  });

  it('shows watts alone without an FTP', () => {
    expect(effortOf(watts(288), undefined)).toEqual({ kind: 'power', watts: '288', percent: undefined });
  });

  it('shows a range and a ramp', () => {
    expect(effortOf(watts(270, 290), 250)).toEqual({ kind: 'power', watts: '270–290', percent: '108–116' });
    expect(effortOf(watts(125, 125, 188), 250)).toEqual({ kind: 'power', watts: '125 → 188', percent: '50 → 75' });
  });

  it('keeps a target still in % and adds watts when it can', () => {
    const effort: WorkoutEffort = { kind: 'target', primary: { unit: 'percent-ftp', start: { low: 90, high: 90 } } };
    expect(effortOf(effort, 250)).toEqual({ kind: 'power', watts: '225', percent: '90' });
    expect(effortOf(effort, undefined)).toEqual({ kind: 'power', watts: undefined, percent: '90' });
  });

  it('names the steps without a power target', () => {
    expect(effortOf({ kind: 'free' }, 250)).toEqual({ kind: 'free' });
    expect(effortOf({ kind: 'max-effort' }, 250)).toEqual({ kind: 'max-effort' });
    expect(effortOf({ kind: 'target', primary: { unit: 'bpm', start: { low: 150, high: 150 } } }, 250)).toEqual({
      kind: 'heart-rate',
      bpm: '150',
    });
  });

  it('reads the cadence beside the power', () => {
    const effort: WorkoutEffort = {
      kind: 'target',
      primary: { unit: 'watts', start: { low: 288, high: 288 } },
      secondary: [{ unit: 'rpm', start: { low: 95, high: 105 } }],
    };
    expect(cadenceOf(effort)).toBe('95–105');
    expect(cadenceOf(watts(288))).toBeUndefined();
    expect(cadenceOf({ kind: 'max-effort' })).toBeUndefined();
    expect(rangeText({ low: 90, high: 90 })).toBe('90');
  });
});

describe('the length of a segment', () => {
  it('splits it into hours, minutes and seconds', () => {
    expect(spanOf(240)).toEqual({ hours: 0, minutes: 4, seconds: 0 });
    expect(spanOf(90)).toEqual({ hours: 0, minutes: 1, seconds: 30 });
    expect(spanOf(3900.4)).toEqual({ hours: 1, minutes: 5, seconds: 0 });
    expect(spanOf(-3)).toEqual({ hours: 0, minutes: 0, seconds: 0 });
  });
});

describe('cues', () => {
  const cues = [
    { offsetSeconds: 30, durationSeconds: 15, text: 'Stay seated' },
    { offsetSeconds: 100, text: 'Out of the saddle' },
  ];

  it('are up from their offset for their duration', () => {
    expect(cueAt(cues, 29)).toBeUndefined();
    expect(cueAt(cues, 30)?.text).toBe('Stay seated');
    expect(cueAt(cues, 44)?.text).toBe('Stay seated');
    expect(cueAt(cues, 45)).toBeUndefined();
  });

  it('stay up ten seconds without a duration of their own', () => {
    expect(cueAt(cues, 109)?.text).toBe('Out of the saddle');
    expect(cueAt(cues, 110)).toBeUndefined();
  });
});

describe('the countdown', () => {
  it('counts 3, 2, 1 before a step that another follows', () => {
    expect([4, 3, 2, 1, 0].map((left) => countdownAt(left, true))).toEqual([undefined, 3, 2, 1, undefined]);
  });

  it('is silent at the end of the workout and for steps without a time', () => {
    expect(countdownAt(2, false)).toBeUndefined();
    expect(countdownAt(undefined, true)).toBeUndefined();
  });
});

describe('the time in the step', () => {
  const base = { stepStartedAt: 1000, pausedAt: undefined, pausedMs: 0 };

  it('counts whole seconds from the start of the step', () => {
    expect(elapsedSeconds({ ...base, now: 1000 })).toBe(0);
    expect(elapsedSeconds({ ...base, now: 1999 })).toBe(0);
    expect(elapsedSeconds({ ...base, now: 134_000 })).toBe(133);
  });

  it('leaves out the time the ride stood still', () => {
    expect(elapsedSeconds({ ...base, now: 134_000, pausedMs: 30_000 })).toBe(103);
  });

  it('holds at the pause while it lasts', () => {
    expect(elapsedSeconds({ ...base, now: 500_000, pausedAt: 61_000 })).toBe(60);
  });

  it('never goes below the start', () => {
    expect(elapsedSeconds({ ...base, now: 0 })).toBe(0);
  });
});

describe('how hard a step is', () => {
  it('reads % FTP with an FTP, watts without one, and a ramp by its end', () => {
    expect(effortLevel(watts(288), 250)).toEqual({ value: 115.2, percentFtp: 115.2, max: false });
    expect(effortLevel(watts(288), undefined)).toEqual({ value: 288, percentFtp: undefined, max: false });
    expect(effortLevel(watts(100, 100, 200), 250).percentFtp).toBe(80);
    expect(effortLevel({ kind: 'max-effort' }, 250).max).toBe(true);
    expect(effortLevel({ kind: 'free' }, 250).value).toBeUndefined();
  });

});

describe('the colour of a zone', () => {
  it('spreads seven zones over the ramp as the chart does', () => {
    expect(zoneColour(1, 7)).toBe('#0a3aff');
    expect(zoneColour(7, 7)).toBe('#8b49fa');
  });

  it('lights it in Display P3 at full brightness', () => {
    expect(vivid('#0a3aff')).toBe('color(display-p3 0.039 0.227 1.000)');
  });

  it('writes on its chip in the ink that reads best', () => {
    expect(inkOn('#0a3aff')).toBe('#f2f5fa');
    expect(inkOn('#f5ff3d')).toBe('#0b1220');
    expect(inkOn('#0ffae3')).toBe('#0b1220');
  });
});
