// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TemporalValue } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import { dampedDistance, dampedDistanceIntegral, dampedDistanceInverse } from './damping.ts';
import { IntervalEstimator } from './intervals.ts';
import { TemporalSeries } from './series.ts';
import { buildSnapshot } from './snapshot.ts';

const T0 = Date.UTC(2026, 10, 1, 10, 0, 0, 0);

function series(strategy: 'hold' | 'damped-trend', values: Array<[number, number]>) {
  const s = new TemporalSeries({ strategy });
  for (const [value, at] of values) {
    s.record({ value, measuredAt: T0 + at, receivedAt: T0 + at, sourceId: 'dev' });
  }
  return s;
}

const RISING: Array<[number, number]> = [
  [180, 0],
  [190, 250],
  [200, 500],
  [210, 750],
];

function numberOf(v: TemporalValue): number {
  if (v.status !== 'available') {
    throw new Error(`unavailable: ${v.reason}`);
  }
  return v.value;
}

/** Midpoint rule over `valueAt`, skipping unavailable times. */
function numericAverage(s: TemporalSeries, window: number, at: number, now: number) {
  const steps = 200_000;
  const dt = window / steps;
  let sum = 0;
  let covered = 0;
  for (let i = 0; i < steps; i += 1) {
    const v = s.valueAt(at - window + (i + 0.5) * dt, now);
    if (v.status === 'available') {
      sum += v.value * dt;
      covered += dt;
    }
  }
  return { value: sum / covered, coverage: covered / window };
}

describe('damped distance', () => {
  const T = 250;

  it('runs fully for T, decays with τ = T and holds from 3 T', () => {
    expect(dampedDistance(100, T)).toBe(100);
    expect(dampedDistance(T, T)).toBe(T);
    expect(dampedDistance(2 * T, T)).toBeCloseTo(T + T * (1 - Math.exp(-1)), 10);
    expect(dampedDistance(10 * T, T)).toBe(dampedDistance(3 * T, T));
  });

  it('has a closed-form integral that matches numerical integration', () => {
    for (const delta of [0, 120, 250, 400, 750, 1200]) {
      const steps = 100_000;
      let numeric = 0;
      for (let i = 0; i < steps; i += 1) {
        numeric += dampedDistance(((i + 0.5) * delta) / steps, T) * (delta / steps);
      }
      expect(dampedDistanceIntegral(delta, T)).toBeCloseTo(numeric, 3);
    }
  });

  it('inverts D inside the extrapolation and nowhere beyond it', () => {
    for (const delta of [10, 250, 400, 749]) {
      expect(dampedDistanceInverse(dampedDistance(delta, T), T)).toBeCloseTo(delta, 6);
    }
    expect(dampedDistanceInverse(dampedDistance(3 * T, T) + 1, T)).toBeUndefined();
  });
});

describe('interval estimation', () => {
  const learn = (intervals: number[]) => {
    const estimator = new IntervalEstimator();
    for (const interval of intervals) {
      estimator.add(interval);
    }
    return estimator.interval;
  };

  it('is unknown before three intervals', () => {
    expect(learn([250, 250])).toBeUndefined();
    expect(learn([250, 250, 250])).toBe(250);
  });

  it('takes the mean of the two middle values for an even count', () => {
    expect(learn([250, 250, 250, 250, 500, 500, 500, 500])).toBe(375);
    expect(learn([240, 270, 250, 230])).toBe(245);
  });

  it('keeps only the last 8 intervals', () => {
    expect(learn([100, 100, 100, 100, 100, 200, 200, 200, 200, 200, 200])).toBe(200);
  });

  it('ignores single gaps and intervals of zero or less', () => {
    expect(learn([250, 250, 250, 1000, 250, 0, -5])).toBe(250);
  });

  it('follows a sustained change only after three consistent outliers', () => {
    expect(learn([250, 250, 250, 1000, 1000])).toBe(250);
    expect(learn([250, 250, 250, 1000, 1000, 1000])).toBe(1000);
    expect(learn([250, 250, 250, 700, 1500, 3000])).toBe(250);
  });

  it('forgets an outlier run when a regular interval arrives', () => {
    expect(learn([250, 250, 250, 1000, 1000, 250, 1000])).toBe(250);
  });
});

describe('value at time', () => {
  const now = T0 + 10_000;

  it('measures, interpolates, extrapolates with damping and holds', () => {
    const s = series('damped-trend', RISING);
    expect(s.valueAt(T0 + 500, now)).toMatchObject({ value: 200, quality: 'measured' });
    expect(s.valueAt(T0 + 625, now)).toMatchObject({ value: 205, quality: 'interpolated' });
    expect(numberOf(s.valueAt(T0 + 1000, now))).toBeCloseTo(220, 6);
    expect(numberOf(s.valueAt(T0 + 1250, now))).toBeCloseTo(226.32, 2);
    expect(s.valueAt(T0 + 1500, now)).toMatchObject({ quality: 'extrapolated' });
    expect(numberOf(s.valueAt(T0 + 1500, now))).toBeCloseTo(228.65, 2);
    expect(s.valueAt(T0 + 2000, now)).toMatchObject({ quality: 'held' });
    expect(s.valueAt(T0 + 2750, now)).toMatchObject({ status: 'unavailable', reason: 'stale' });
  });

  it('is out of range after now and before the history', () => {
    const s = series('damped-trend', RISING);
    expect(s.valueAt(T0 + 800, T0 + 750)).toMatchObject({ reason: 'out-of-range' });
    expect(s.valueAt(T0 - 1, T0 + 750)).toMatchObject({ reason: 'out-of-range' });
    expect(new TemporalSeries({ strategy: 'hold' }).valueAt(T0, T0)).toMatchObject({
      reason: 'no-source',
    });
  });

  it('never estimates across a disconnect and drops the old trend afterwards', () => {
    const s = series('damped-trend', RISING);
    s.markDisconnected(T0 + 900);
    expect(numberOf(s.valueAt(T0 + 800, now))).toBeCloseTo(212, 6);
    expect(s.valueAt(T0 + 900, now)).toMatchObject({ reason: 'disconnected' });
    expect(s.freshnessAt(T0 + 950)).toBe('disconnected');
    s.record({ value: 230, measuredAt: T0 + 1000, receivedAt: T0 + 1000, sourceId: 'dev' });
    expect(s.valueAt(T0 + 950, now)).toMatchObject({ reason: 'disconnected' });
    expect(s.valueAt(T0 + 1100, now)).toMatchObject({ value: 230, quality: 'held' });
  });
});

describe('history', () => {
  it('keeps 60 s by measurement time', () => {
    const s = new TemporalSeries({ strategy: 'hold' });
    for (let at = 0; at <= 70_000; at += 1000) {
      s.record({ value: 1, measuredAt: T0 + at, receivedAt: T0 + at, sourceId: 'dev' });
    }
    expect(s.historySize).toBe(61);
  });

  it('keeps at most 600 measurements', () => {
    const s = new TemporalSeries({ strategy: 'hold' });
    for (let at = 0; at < 700 * 50; at += 50) {
      s.record({ value: 1, measuredAt: T0 + at, receivedAt: T0 + at, sourceId: 'dev' });
    }
    expect(s.historySize).toBe(600);
  });

  it('accepts the first measurement after a disconnect at the same instant', () => {
    const s = series('damped-trend', RISING);
    s.markDisconnected(T0 + 750);
    const back = { value: 230, measuredAt: T0 + 750, receivedAt: T0 + 750, sourceId: 'dev' };
    expect(s.record(back)).toBe('accepted');
    expect(s.valueAt(T0 + 750, T0 + 750)).toMatchObject({ value: 230, quality: 'measured' });
    expect(s.record({ ...back, value: 240 })).toBe('late');
  });

  it('rejects late measurements and ignores duplicates', () => {
    const s = series('damped-trend', RISING);
    const late = { value: 205, measuredAt: T0 + 600, receivedAt: T0 + 800, sourceId: 'dev' };
    expect(s.record(late)).toBe('late');
    const duplicate = { value: 210, measuredAt: T0 + 750, receivedAt: T0 + 760, sourceId: 'dev' };
    expect(s.record(duplicate)).toBe('duplicate');
    expect(s.historySize).toBe(4);
    expect(s.nextExpectedAt).toBe(T0 + 1000);
  });
});

describe('freshness', () => {
  it('moves fresh -> delayed -> stale on half-open bounds', () => {
    const s = series('hold', RISING);
    expect(s.freshnessAt(T0 + 1124)).toBe('fresh');
    expect(s.freshnessAt(T0 + 1125)).toBe('delayed');
    expect(s.nextTransition(T0 + 800)).toEqual({ at: T0 + 1125, freshness: 'delayed' });
    expect(s.nextTransition(T0 + 1125)).toEqual({ at: T0 + 2750, freshness: 'stale' });
    expect(s.freshnessAt(T0 + 2750)).toBe('stale');
    expect(s.nextTransition(T0 + 2750)).toBeUndefined();
  });

  it('falls back to 3 s while the interval is unknown', () => {
    const s = series('hold', [
      [1, 0],
      [1, 250],
    ]);
    expect(s.nextTransition(T0 + 250)).toEqual({ at: T0 + 3250, freshness: 'stale' });
  });
});

describe('time-weighted average', () => {
  it('equals the numerical integral of valueAt for a trend series', () => {
    const s = series('damped-trend', [...RISING, [150, 1000], [160, 1250]]);
    const now = T0 + 5000;
    for (const [window, at] of [
      [1000, T0 + 1000],
      [2000, T0 + 2000],
      [5000, T0 + 4000],
    ] as const) {
      const closed = s.average(window, at, now);
      const numeric = numericAverage(s, window, at, now);
      expect(closed.value).toBeCloseTo(numeric.value, 2);
      expect(closed.coverage).toBeCloseTo(numeric.coverage, 3);
    }
  });

  it('matches the numerical integral where an estimate hits the minimum', () => {
    const s = series('damped-trend', [
      [30, 0],
      [20, 250],
      [10, 500],
      [0, 750],
    ]);
    const closed = s.average(1500, T0 + 1500, T0 + 1500);
    const numeric = numericAverage(s, 1500, T0 + 1500, T0 + 1500);
    expect(closed.value).toBeCloseTo(numeric.value, 2);
  });

  it('reports the least certain quality and the covered share', () => {
    const s = series('damped-trend', RISING);
    expect(s.average(1000, T0 + 1000, T0 + 1000)).toMatchObject({
      value: 200,
      coverage: 1,
      quality: 'extrapolated',
    });
    expect(s.average(1000, T0 + 4000, T0 + 4000)).toEqual({
      at: T0 + 4000,
      window: 1000,
      coverage: 0,
    });
  });
});

describe('determinism', () => {
  it('gives deep-equal answers when the same input is replayed', () => {
    const run = () => {
      const s = series('damped-trend', [...RISING, [260, 2000], [240, 2600], [255, 2850]]);
      s.markDisconnected(T0 + 3000);
      s.record({ value: 100, measuredAt: T0 + 6000, receivedAt: T0 + 6010, sourceId: 'dev' });
      const now = T0 + 7000;
      return {
        values: [0, 100, 777, 1600, 2700, 3100, 6500].map((t) => s.valueAt(T0 + t, now)),
        average: s.average(7000, now, now),
        snapshot: buildSnapshot(new Map([['a', s]]), T0 + 2900, now),
        freshness: s.freshnessAt(now),
        next: s.nextTransition(now),
      };
    };
    expect(run()).toEqual(run());
  });
});
