// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import {
  angleOf,
  bandAt,
  cadenceScale,
  bandNear,
  CADENCE_COLOURS,
  dimmed,
  drawsOnHdrCanvas,
  LIT_LIGHTNESS,
  lit,
  TRACK_LIGHTNESS,
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

  it.each([
    [187, 190],
    [190, 190],
    [201, 210],
  ])('ends at the maximum heart rate %i rounded up to the next 10: %i', (maxHeartRate, end) => {
    expect(heartRateScale(undefined, 170, maxHeartRate).max).toBe(end);
  });

  it('labels the end of a scale set by the maximum heart rate with a major tick', () => {
    const scale = heartRateScale(undefined, 170, 187);
    expect((scale.max - scale.min) % scale.major).toBe(0);
    expect(ticksOf(scale).at(-1)).toEqual({ value: 190, major: true });
    expect(scale.min).toBeLessThanOrEqual(100);
  });

  it('keeps its own end without a maximum heart rate', () => {
    expect(heartRateScale(undefined, 170, undefined).max).toBe(200);
  });

  it('is neutral without zones and LTHR', () => {
    expect(heartRateScale(undefined, undefined, undefined).bands).toEqual([]);
  });
});

describe('cadenceScale', () => {
  it('has five fixed bands up to 150 rpm', () => {
    expect(cadenceScale().bands.map((band) => band.to)).toEqual([60, 75, 90, 105, 150]);
  });

  it('colours the sweet spot green and both ends amber, not by the effort ramp', () => {
    expect(cadenceScale().bands.map((band) => band.colour)).toEqual([...CADENCE_COLOURS]);
    expect(bandAt(cadenceScale(), 95)?.colour).toBe('#3ddc84');
    expect(bandAt(cadenceScale(), 120)?.colour).toBe('#ffb62e');
  });
});

describe('angleOf and ticksOf', () => {
  it('sweeps from the start to the end and holds at the ends', () => {
    const scale = cadenceScale();
    expect(angleOf(scale, 0)).toBe(START_ANGLE);
    expect(angleOf(scale, 75)).toBe(START_ANGLE + SWEEP / 2);
    expect(angleOf(scale, 999)).toBe(START_ANGLE + SWEEP);
    expect(angleOf(scale, -5)).toBe(START_ANGLE);
  });

  it('marks every major step', () => {
    const majors = ticksOf(cadenceScale()).filter((tick) => tick.major);
    expect(majors.map((tick) => tick.value)).toEqual([0, 30, 60, 90, 120, 150]);
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

  it('lifts a dark zone colour to a readable lightness, its hue unchanged', () => {
    expect(lit('#0a3aff')).toBe(`oklch(from ${vivid('#0a3aff')} max(l, ${LIT_LIGHTNESS}) c h)`);
  });

  it('draws the track of every zone at one lightness, solid', () => {
    expect(dimmed('#fe2966')).toBe(`oklch(from #fe2966 ${TRACK_LIGHTNESS} calc(c * 0.6) h)`);
    expect(dimmed('#fe2966')).not.toMatch(/\//);
  });
});

describe('bandNear', () => {
  // FTP 250: zone 2 ends at 75 % (187.5 W), the scale spans 0 to 500 W, so the margin is 5 W.
  const scale = powerScale(250, undefined);

  it('takes the exact zone without one shown so far', () => {
    expect(bandNear(scale, 189, undefined)?.zone).toBe(3);
  });

  it('keeps the zone shown while the value wavers just across its bound', () => {
    expect(bandNear(scale, 189, 2)?.zone).toBe(2);
    expect(bandNear(scale, 186, 3)?.zone).toBe(3);
  });

  it('changes the zone once the value is clearly in another one', () => {
    expect(bandNear(scale, 193, 2)?.zone).toBe(3);
    expect(bandNear(scale, 180, 3)?.zone).toBe(2);
    expect(bandNear(scale, 400, 1)?.zone).toBe(7);
  });
});

describe('drawsOnHdrCanvas', () => {
  it('shows the dial on the HDR canvas only with one and while no screenshot is taken', () => {
    expect(drawsOnHdrCanvas(true, false)).toBe(true);
    // The snapshot fills a see-through WebGPU canvas with black: the SVG shows instead.
    expect(drawsOnHdrCanvas(true, true)).toBe(false);
    expect(drawsOnHdrCanvas(false, false)).toBe(false);
    expect(drawsOnHdrCanvas(false, true)).toBe(false);
  });
});
