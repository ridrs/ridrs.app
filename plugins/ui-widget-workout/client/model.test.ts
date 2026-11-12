// SPDX-License-Identifier: AGPL-3.0-or-later

import type { WorkoutEffort } from '@ridrs/contracts';
import type { TimelineSegment } from '@ridrs/workout';
import { describe, expect, it } from 'vitest';
import { cadenceOf, clock, countdownAt, cueAt, effortOf, elapsedSeconds, rangeText, setOf } from './model.ts';

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

describe('the set', () => {
  const segment = (repeats: TimelineSegment['repeats'], index = 4): TimelineSegment =>
    ({ index, repeats }) as TimelineSegment;

  it('is the round of the innermost counted repeat', () => {
    expect(setOf(segment([{ repeatId: 'a', iteration: 3, count: 5 }]), 10)).toEqual({ at: 3, of: 5 });
    expect(
      setOf(segment([{ repeatId: 'a', iteration: 1, count: 2 }, { repeatId: 'b', iteration: 4, count: 6 }]), 10),
    ).toEqual({ at: 4, of: 6 });
  });

  it('is the place among the steps without a counted repeat', () => {
    expect(setOf(segment([]), 10)).toEqual({ at: 5, of: 10 });
    expect(setOf(segment([{ repeatId: 'a', iteration: 1 }]), 10)).toEqual({ at: 5, of: 10 });
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
