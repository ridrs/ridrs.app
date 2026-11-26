// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { HALT_DEFAULTS, type HaltView, WorkoutHalt } from './halt.ts';

const TICK = HALT_DEFAULTS.tickMs;

/** Looks every 250 ms from `from` to `to` (ms) with the same reading; the last view. */
function ride(
  halt: WorkoutHalt,
  from: number,
  to: number,
  watts: number | undefined,
  rpm: number | undefined,
  target: number | null = 300,
): HaltView[] {
  const views: HaltView[] = [];
  for (let at = from; at <= to; at += TICK) {
    views.push(
      halt.look(
        { at, ...(watts === undefined ? {} : { watts }), ...(rpm === undefined ? {} : { rpm }) },
        target,
      ),
    );
  }
  return views;
}

describe('WorkoutHalt', () => {
  it('halts after no power for 1 s', () => {
    const halt = new WorkoutHalt();
    ride(halt, 0, 5000, 300, 90);
    const views = ride(halt, 5250, 6250, 0, 0);
    expect(views.at(-2)?.state).toBe('running');
    expect(views.at(-1)?.state).toBe('halted');
  });

  it('does not halt without a cadence, nor without a target', () => {
    const halt = new WorkoutHalt();
    expect(ride(halt, 0, 5000, 0, undefined).at(-1)?.state).toBe('running');
    expect(ride(halt, 5250, 10_000, 0, 0, null).at(-1)?.state).toBe('running');
  });

  it('halts in a spiral: below 45 rpm for 3 s while the power falls short', () => {
    const halt = new WorkoutHalt();
    ride(halt, 0, 5000, 300, 90);
    expect(ride(halt, 5250, 8000, 240, 40).at(-1)?.state).toBe('running');
    expect(ride(halt, 8250, 8250, 240, 40).at(-1)?.state).toBe('halted');
  });

  it('does not halt at a low cadence while the target is held', () => {
    const halt = new WorkoutHalt();
    expect(ride(halt, 0, 20_000, 300, 40).at(-1)?.state).toBe('running');
  });

  it('ignores the cadence for 3 s after halting, then starts the countdown after 2 s at 30 rpm', () => {
    const halt = new WorkoutHalt();
    ride(halt, 0, 5000, 300, 90);
    ride(halt, 5250, 6250, 0, 0); // halted at 6250
    expect(ride(halt, 6500, 10_000, 100, 40).at(-1)?.state).toBe('halted'); // counts from 9250
    const view = ride(halt, 10_250, 11_250, 100, 40).at(-1);
    expect(view).toEqual({ state: 'countdown', secondsLeft: 5, waiting: true, ceiling: 100 });
  });

  it('counts only at 55 rpm and ramps from the power pedalled to the target', () => {
    const halt = new WorkoutHalt();
    ride(halt, 0, 5000, 300, 90);
    ride(halt, 5250, 6250, 0, 0);
    ride(halt, 6500, 11_250, 100, 40); // countdown from 11250, waiting
    const ramp = ride(halt, 11_500, 16_250, 100, 90);
    expect(ramp[0]).toMatchObject({ state: 'countdown', secondsLeft: 5, rampWatts: 110 });
    expect(ramp.at(-2)).toMatchObject({ state: 'countdown', secondsLeft: 1, rampWatts: 290 });
    expect(ramp.at(-1)).toEqual({ state: 'running', ceiling: 100 });
  });

  it('ends the countdown below 30 rpm, but not in its first 2 s', () => {
    const halt = new WorkoutHalt();
    ride(halt, 0, 5000, 300, 90);
    ride(halt, 5250, 6250, 0, 0);
    ride(halt, 6500, 11_250, 100, 40); // countdown from 11250
    expect(ride(halt, 11_500, 13_000, 10, 20).at(-1)?.state).toBe('countdown');
    expect(ride(halt, 13_250, 13_250, 10, 20).at(-1)?.state).toBe('halted');
  });

  it('lowers the ceiling by 5 % for a spiral within 60 s of a countdown, until the next step', () => {
    const halt = new WorkoutHalt();
    ride(halt, 0, 5000, 300, 90);
    ride(halt, 5250, 6250, 0, 0);
    ride(halt, 6500, 16_250, 100, 90); // countdown from 11250, running from 16250
    expect(halt.current).toBe('running');
    const spiral = ride(halt, 16_500, 25_000, 240, 40).find((v) => v.state === 'halted');
    expect(spiral?.ceiling).toBe(95);
    halt.stepBegan();
    expect(halt.peek().ceiling).toBe(100);
  });

  it('waits for the first pedal strokes after the rider resumes', () => {
    const halt = new WorkoutHalt();
    ride(halt, 0, 5000, 300, 90);
    halt.resumed(65_000);
    expect(halt.current).toBe('halted');
  });
});
