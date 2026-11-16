// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import {
  angleOf,
  bandAt,
  cadenceScale,
  dimmed,
  formatDuration,
  heartRateScale,
  powerScale,
  RideAverage,
  START_ANGLE,
  vivid,
  SWEEP,
  ticksOf,
} from './model.ts';

describe('powerScale', () => {
  it('colours Coggan zones in watts of the FTP and ends on a round number above them', () => {
    const scale = powerScale(250, undefined);
    expect(scale.bands.map((band) => [band.from, band.to])).toEqual([
      [0, 138],
      [138, 188],
      [188, 225],
      [225, 263],
      [263, 300],
      [300, 375],
      [375, 500],
    ]);
    expect(scale.max).toBe(500);
  });

  it('is neutral without an FTP', () => {
    expect(powerScale(undefined, undefined).bands).toEqual([]);
  });

  it('places a value in its zone by the exact bound', () => {
    const scale = powerScale(250, undefined);
    expect(bandAt(scale, 137.5)?.zone).toBe(1);
    expect(bandAt(scale, 138)?.zone).toBe(2);
    expect(bandAt(scale, 900)?.zone).toBe(7);
  });
});

describe('heartRateScale', () => {
  it('starts below the first bound and colours Friel zones of the LTHR', () => {
    const scale = heartRateScale(undefined, 170, undefined);
    expect(scale.min).toBe(100);
    expect(scale.max).toBe(200);
    expect(scale.bands[0]).toMatchObject({ zone: 1, from: 100, to: 138 });
    expect(scale.bands).toHaveLength(7);
  });

  it('reaches the maximum heart rate', () => {
    expect(heartRateScale(undefined, 170, 205).max).toBeGreaterThanOrEqual(205);
  });

  it('is neutral without zones and LTHR', () => {
    expect(heartRateScale(undefined, undefined, undefined).bands).toEqual([]);
  });
});

describe('cadenceScale', () => {
  it('has five fixed bands up to 140 rpm', () => {
    expect(cadenceScale().bands.map((band) => band.to)).toEqual([60, 75, 90, 105, 140]);
  });
});

describe('angleOf and ticksOf', () => {
  it('sweeps from the start to the end and holds at the ends', () => {
    const scale = cadenceScale();
    expect(angleOf(scale, 0)).toBe(START_ANGLE);
    expect(angleOf(scale, 70)).toBe(START_ANGLE + SWEEP / 2);
    expect(angleOf(scale, 999)).toBe(START_ANGLE + SWEEP);
    expect(angleOf(scale, -5)).toBe(START_ANGLE);
  });

  it('marks every major step', () => {
    const majors = ticksOf(cadenceScale()).filter((tick) => tick.major);
    expect(majors.map((tick) => tick.value)).toEqual([0, 20, 40, 60, 80, 100, 120, 140]);
  });
});

describe('RideAverage', () => {
  const running = (sessionId: string) => ({ state: 'running', sessionId, startedAt: 0 }) as const;
  const paused = (sessionId: string) =>
    ({ state: 'paused', sessionId, startedAt: 0, pausedAt: 1, reason: 'rider' }) as const;

  it('counts readings published while the ride runs, once each', () => {
    const average = new RideAverage();
    average.add(500, 1);
    average.activity(running('a'), 2);
    average.add(100, 3);
    average.add(100, 3);
    average.add(300, 4);
    expect(average.value).toBe(200);
  });

  it('skips pauses, replays from before the ride and unavailable readings', () => {
    const average = new RideAverage();
    average.activity(running('a'), 10);
    average.add(999, 5);
    average.add(200, 11);
    average.activity(paused('a'), 12);
    average.add(600, 13);
    average.activity(running('a'), 14);
    average.add(undefined, 15);
    average.add(100, 16);
    expect(average.value).toBe(150);
  });

  it('counts a reading that reached it before the state of the running ride', () => {
    const average = new RideAverage();
    average.add(240, 7);
    average.activity(running('a'), 5);
    expect(average.value).toBe(240);
  });

  it('starts from none on a new session', () => {
    const average = new RideAverage();
    average.activity(running('a'), 1);
    average.add(300, 2);
    average.activity(running('b'), 3);
    expect(average.value).toBeUndefined();
  });
});

describe('formatDuration', () => {
  it('shows minutes and seconds below an hour, hours above', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(245.9)).toBe('4:05');
    expect(formatDuration(3723.5)).toBe('1:02:03');
  });
});

describe('the solid colours of the dial', () => {
  it('lights a colour at full brightness in Display P3', () => {
    expect(vivid('#f68c14')).toBe('color(display-p3 1.000 0.569 0.081)');
  });

  it('dims a colour towards the dial without making it see-through', () => {
    expect(dimmed('#ffffff', 0)).toBe('rgb(255 255 255)');
    expect(dimmed('#ffffff', 1)).toBe('rgb(11 18 32)');
    expect(dimmed('#fe2966')).toMatch(/^rgb\(\d+ \d+ \d+\)$/);
  });
});
