// SPDX-License-Identifier: AGPL-3.0-or-later

import type { WorkoutInterval } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import { draggedPower, draggedSeconds, handlesOf, powerOf } from './handles.ts';

const step = (effort: WorkoutInterval['effort'], duration: WorkoutInterval['duration'] = { kind: 'time', seconds: 300 }): WorkoutInterval => ({
  kind: 'interval',
  id: 'a',
  duration,
  effort,
});
const percent = (low: number, high = low, end?: number): WorkoutInterval['effort'] => ({
  kind: 'target',
  primary: {
    unit: 'percent-ftp',
    start: { low, high },
    ...(end === undefined ? {} : { end: { low: end, high: end } }),
  },
});

describe('handles', () => {
  it('a steady step has a duration and a power handle, a ramp one at each end', () => {
    expect(handlesOf(step(percent(90)))).toEqual(['duration', 'power']);
    expect(handlesOf(step(percent(50, 50, 75)))).toEqual(['duration', 'power-start', 'power-end']);
  });

  it('a range, a free ride and a step by heart rate or distance have fewer', () => {
    expect(handlesOf(step(percent(85, 95)))).toEqual(['duration']);
    expect(handlesOf(step({ kind: 'free' }))).toEqual(['duration']);
    expect(handlesOf(step({ kind: 'max-effort' }, { kind: 'open' }))).toEqual([]);
    expect(
      handlesOf(
        step({ kind: 'target', primary: { unit: 'bpm', start: { low: 140, high: 140 } } }, { kind: 'distance', meters: 1000 }),
      ),
    ).toEqual([]);
  });

  it('reads the power of the handle in the unit of the step', () => {
    expect(powerOf(step(percent(50, 50, 75)), 'power-start')).toBe(50);
    expect(powerOf(step(percent(50, 50, 75)), 'power-end')).toBe(75);
  });
});

describe('dragging', () => {
  it('snaps a duration to 15 s and keeps at least 15 s', () => {
    expect(draggedSeconds(300, 22)).toBe(315);
    expect(draggedSeconds(300, 7)).toBe(300);
    expect(draggedSeconds(300, -400)).toBe(15);
  });

  it('snaps a power to whole percent between 0 and 300 %', () => {
    const percentStep = { axis: 'percent-ftp', target: 'percent-ftp' } as const;
    expect(draggedPower(90, 4.4, percentStep)).toBe(94);
    expect(draggedPower(90, -500, percentStep)).toBe(0);
    expect(draggedPower(250, 100, percentStep)).toBe(300);
  });

  it('translates the movement between watts and percent with the FTP, never without', () => {
    expect(draggedPower(200, 10, { axis: 'percent-ftp', target: 'watts', ftp: 250 })).toBe(225);
    expect(draggedPower(80, 25, { axis: 'watts', target: 'percent-ftp', ftp: 250 })).toBe(90);
    expect(draggedPower(200, 10, { axis: 'percent-ftp', target: 'watts' })).toBe(200);
  });
});
