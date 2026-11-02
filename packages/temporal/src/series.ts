// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  EstimationStrategy,
  Freshness,
  TemporalAverage,
  TemporalMeasurement,
  TemporalQuality,
  TemporalRecordResult,
  TemporalUnavailableReason,
  TemporalValue,
} from '@ridrs/contracts';
import { linearRegression } from 'simple-statistics';
import { dampedDistance, dampedDistanceIntegral, dampedDistanceInverse } from './damping.ts';
import { TEMPORAL_DEFAULTS } from './defaults.ts';
import { IntervalEstimator } from './intervals.ts';

/** What lies between an entry and the one before it. */
type GapBefore = 'start' | 'none' | 'stale' | 'break';

interface Entry extends TemporalMeasurement {
  readonly gapBefore: GapBefore;
  /** T as learned right after this entry was recorded. */
  readonly interval?: number;
  /** Stale threshold in force after this entry. */
  readonly staleAfter: number;
  /** Trend at this entry, per ms; 0 means no trend. */
  readonly slope: number;
}

export interface TemporalSeriesOptions {
  readonly strategy: EstimationStrategy;
  readonly min?: number;
}

export interface FreshnessTransition {
  readonly at: number;
  readonly freshness: Freshness;
}

/** A stretch of the time axis on which `valueAt` is available, with its integral in closed form. */
interface Piece {
  readonly from: number;
  readonly to: number;
  readonly quality: TemporalQuality;
  integrate(lo: number, hi: number): number;
}

const QUALITY_RANK: Readonly<Record<TemporalQuality, number>> = {
  measured: 0,
  interpolated: 1,
  held: 2,
  extrapolated: 3,
};

export function staleAfterFor(interval: number | undefined): number {
  if (interval === undefined) {
    return TEMPORAL_DEFAULTS.fallbackStaleAfterMs;
  }
  return Math.min(
    Math.max(TEMPORAL_DEFAULTS.staleAfterIntervals * interval, TEMPORAL_DEFAULTS.minStaleAfterMs),
    TEMPORAL_DEFAULTS.maxStaleAfterMs,
  );
}

function unavailable(at: number, reason: TemporalUnavailableReason): TemporalValue {
  return { status: 'unavailable', at, reason };
}

function constantPiece(from: number, to: number, value: number, quality: TemporalQuality): Piece {
  return { from, to, quality, integrate: (lo, hi) => value * (hi - lo) };
}

/**
 * One series of measurements of one source, on explicit timestamps: no clock, no timers. The
 * same input sequence always gives the same answers.
 */
export class TemporalSeries {
  readonly strategy: EstimationStrategy;
  readonly min: number;
  private entries: Entry[] = [];
  /** Disconnect marks; nothing is interpolated or extrapolated across one. */
  private breaks: number[] = [];
  private intervals = new IntervalEstimator();
  private lastReceivedAt?: number;
  private disconnected = false;

  constructor(options: TemporalSeriesOptions) {
    this.strategy = options.strategy;
    this.min = options.min ?? TEMPORAL_DEFAULTS.minValue;
  }

  get samplingInterval(): number | undefined {
    return this.intervals.interval;
  }

  get nextExpectedAt(): number | undefined {
    const interval = this.intervals.interval;
    return interval === undefined || this.lastReceivedAt === undefined
      ? undefined
      : this.lastReceivedAt + interval;
  }

  get historySize(): number {
    return this.entries.length;
  }

  record(measurement: TemporalMeasurement): TemporalRecordResult {
    const last = this.entries.at(-1);
    // A disconnect closes the stretch: its first measurement may share the last timestamp.
    const sameInstantAfterBreak = this.disconnected && measurement.measuredAt === last?.measuredAt;
    if (last && !sameInstantAfterBreak) {
      if (measurement.measuredAt === last.measuredAt && measurement.value === last.value) {
        return 'duplicate';
      }
      if (measurement.measuredAt <= last.measuredAt) {
        return 'late';
      }
    }

    if (this.lastReceivedAt !== undefined) {
      this.intervals.add(measurement.receivedAt - this.lastReceivedAt);
    }
    const interval = this.intervals.interval;

    let gapBefore: GapBefore = 'start';
    if (last) {
      // Pending marks lie between the last entry and this one, at the latest at this one.
      this.breaks = this.breaks.map((at) =>
        at >= last.measuredAt ? Math.min(at, measurement.measuredAt) : at,
      );
      if (this.breaks.some((at) => at >= last.measuredAt)) {
        gapBefore = 'break';
      } else if (measurement.receivedAt - last.receivedAt >= last.staleAfter) {
        gapBefore = 'stale';
      } else {
        gapBefore = 'none';
      }
    }

    const entry: Entry = {
      value: measurement.value,
      measuredAt: measurement.measuredAt,
      receivedAt: measurement.receivedAt,
      sourceId: measurement.sourceId,
      gapBefore,
      interval,
      staleAfter: staleAfterFor(interval),
      slope: this.trendSlope(measurement, interval, gapBefore),
    };
    this.entries.push(entry);
    this.lastReceivedAt = measurement.receivedAt;
    this.disconnected = false;
    this.trim(measurement.measuredAt);
    return 'accepted';
  }

  markDisconnected(at: number): void {
    const last = this.entries.at(-1);
    if (!last) {
      return;
    }
    this.breaks.push(Math.max(at, last.measuredAt));
    this.disconnected = true;
  }

  reset(): void {
    this.entries = [];
    this.breaks = [];
    this.intervals = new IntervalEstimator();
    this.lastReceivedAt = undefined;
    this.disconnected = false;
  }

  freshnessAt(now: number): Freshness {
    const last = this.entries.at(-1);
    if (this.lastReceivedAt === undefined || !last) {
      return 'none';
    }
    if (this.disconnected) {
      return 'disconnected';
    }
    const elapsed = now - this.lastReceivedAt;
    if (elapsed >= last.staleAfter) {
      return 'stale';
    }
    const interval = this.intervals.interval;
    if (interval !== undefined && elapsed >= TEMPORAL_DEFAULTS.delayedAfterIntervals * interval) {
      return 'delayed';
    }
    return 'fresh';
  }

  /** The next freshness change after `now` if no measurement arrives, or undefined if none is due. */
  nextTransition(now: number): FreshnessTransition | undefined {
    const last = this.entries.at(-1);
    const current = this.freshnessAt(now);
    if (!last || this.lastReceivedAt === undefined) {
      return undefined;
    }
    const staleAt = this.lastReceivedAt + last.staleAfter;
    const interval = this.intervals.interval;
    const delayedAt =
      interval === undefined
        ? Number.POSITIVE_INFINITY
        : this.lastReceivedAt + TEMPORAL_DEFAULTS.delayedAfterIntervals * interval;
    if (current === 'fresh') {
      return delayedAt < staleAt
        ? { at: delayedAt, freshness: 'delayed' }
        : { at: staleAt, freshness: 'stale' };
    }
    if (current === 'delayed') {
      return { at: staleAt, freshness: 'stale' };
    }
    return undefined;
  }

  valueAt(t: number, now: number): TemporalValue {
    if (this.entries.length === 0) {
      return unavailable(t, 'no-source');
    }
    if (t > now) {
      return unavailable(t, 'out-of-range');
    }
    const index = this.lastIndexAtOrBefore(t);
    const a = this.entries[index];
    if (!a) {
      return unavailable(t, 'out-of-range');
    }
    if (a.measuredAt === t) {
      return this.available(t, a.value, 'measured', a, a.measuredAt);
    }
    if (this.breaks.some((at) => at >= a.measuredAt && at <= t)) {
      return unavailable(t, 'disconnected');
    }

    const b = this.entries[index + 1];
    if (b?.gapBefore === 'none') {
      if (this.strategy === 'hold') {
        return this.available(t, a.value, 'held', a, a.measuredAt);
      }
      const share = (t - a.measuredAt) / (b.measuredAt - a.measuredAt);
      const value = a.value + (b.value - a.value) * share;
      return this.available(t, value, 'interpolated', a, b.measuredAt);
    }

    if (t >= a.receivedAt + a.staleAfter) {
      return unavailable(t, 'stale');
    }
    if (b?.gapBefore === 'stale') {
      return this.available(t, a.value, 'held', a, a.measuredAt);
    }
    const delta = t - a.measuredAt;
    return this.available(
      t,
      this.estimate(a, delta),
      this.estimateQuality(a, delta),
      a,
      a.measuredAt,
    );
  }

  /** Time integral of exactly `valueAt` over `[at - window, at]`, divided by the available time. */
  average(window: number, at: number, now: number): TemporalAverage {
    const lo = at - window;
    const hi = Math.min(at, now);
    let covered = 0;
    let integral = 0;
    let quality: TemporalQuality | undefined;
    for (const piece of this.pieces()) {
      const from = Math.max(lo, piece.from);
      const to = Math.min(hi, piece.to);
      if (to <= from) {
        continue;
      }
      covered += to - from;
      integral += piece.integrate(from, to);
      if (quality === undefined || QUALITY_RANK[piece.quality] > QUALITY_RANK[quality]) {
        quality = piece.quality;
      }
    }
    if (covered <= 0 || window <= 0) {
      return { at, window, coverage: 0 };
    }
    return { at, window, value: integral / covered, coverage: covered / window, quality };
  }

  private available(
    at: number,
    value: number,
    quality: TemporalQuality,
    source: Entry,
    sourceMeasuredAt: number,
  ): TemporalValue {
    return { status: 'available', value, at, quality, sourceId: source.sourceId, sourceMeasuredAt };
  }

  private estimate(a: Entry, delta: number): number {
    if (a.slope === 0 || a.interval === undefined) {
      return a.value;
    }
    return Math.max(this.min, a.value + a.slope * dampedDistance(delta, a.interval));
  }

  private estimateQuality(a: Entry, delta: number): TemporalQuality {
    const holdAt = a.interval === undefined ? 0 : TEMPORAL_DEFAULTS.holdAfterIntervals * a.interval;
    return a.slope !== 0 && delta <= holdAt ? 'extrapolated' : 'held';
  }

  /** Least-squares slope over the in-order measurements of the current stretch within 4 T. */
  private trendSlope(m: TemporalMeasurement, interval: number | undefined, gap: GapBefore): number {
    if (this.strategy !== 'damped-trend' || interval === undefined || gap !== 'none') {
      return 0;
    }
    let start = this.entries.length - 1;
    while (start > 0 && this.entries[start]?.gapBefore === 'none') {
      start -= 1;
    }
    const from = m.measuredAt - TEMPORAL_DEFAULTS.trendWindowIntervals * interval;
    const points = [...this.entries.slice(start), m]
      .filter((e) => e.measuredAt >= from)
      .map((e): [number, number] => [e.measuredAt - m.measuredAt, e.value]);
    if (points.length < TEMPORAL_DEFAULTS.minTrendMeasurements) {
      return 0;
    }
    return linearRegression(points).m;
  }

  private trim(newestMeasuredAt: number): void {
    const oldest = newestMeasuredAt - TEMPORAL_DEFAULTS.historyMs;
    let drop = 0;
    while (drop < this.entries.length - 1 && (this.entries[drop]?.measuredAt ?? 0) < oldest) {
      drop += 1;
    }
    drop = Math.max(drop, this.entries.length - TEMPORAL_DEFAULTS.historyMaxEntries);
    if (drop > 0) {
      this.entries = this.entries.slice(drop);
    }
    const first = this.entries[0]?.measuredAt ?? Number.NEGATIVE_INFINITY;
    this.breaks = this.breaks.filter((at) => at >= first);
  }

  private lastIndexAtOrBefore(t: number): number {
    let lo = 0;
    let hi = this.entries.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((this.entries[mid]?.measuredAt ?? Number.POSITIVE_INFINITY) <= t) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  }

  /** `valueAt` as a list of pieces covering exactly the times it is available. */
  private pieces(): Piece[] {
    const pieces: Piece[] = [];
    this.entries.forEach((a, index) => {
      const b = this.entries[index + 1];
      const end = b?.measuredAt ?? Number.POSITIVE_INFINITY;
      if (b?.gapBefore === 'none') {
        if (this.strategy === 'hold') {
          pieces.push(constantPiece(a.measuredAt, end, a.value, 'held'));
        } else {
          const slope = (b.value - a.value) / (b.measuredAt - a.measuredAt);
          const at = (t: number) => a.value + slope * (t - a.measuredAt);
          pieces.push({
            from: a.measuredAt,
            to: end,
            quality: 'interpolated',
            integrate: (lo, hi) => ((at(lo) + at(hi)) / 2) * (hi - lo),
          });
        }
        return;
      }
      const breakAt = this.breaks.find((at) => at >= a.measuredAt && at < end);
      const until = Math.min(end, breakAt ?? end, a.receivedAt + a.staleAfter);
      if (b?.gapBefore === 'stale') {
        pieces.push(constantPiece(a.measuredAt, until, a.value, 'held'));
      } else {
        pieces.push(...this.estimatePieces(a, until));
      }
    });
    return pieces;
  }

  /** The estimate after `a` up to `until`, split where its quality or the minimum clamp changes. */
  private estimatePieces(a: Entry, until: number): Piece[] {
    const interval = a.interval;
    if (a.slope === 0 || interval === undefined) {
      return [constantPiece(a.measuredAt, until, a.value, 'held')];
    }
    const holdAt = TEMPORAL_DEFAULTS.holdAfterIntervals * interval;
    const crossing = dampedDistanceInverse((this.min - a.value) / a.slope, interval);
    const cuts = [0, holdAt, ...(crossing !== undefined && crossing > 0 ? [crossing] : [])]
      .map((delta) => a.measuredAt + delta)
      .filter((t) => t < until)
      .sort((x, y) => x - y);
    const bounds = [...new Set(cuts), until];
    const raw = (delta: number) => a.value + a.slope * dampedDistance(delta, interval);
    const rawIntegral = (d0: number, d1: number) =>
      a.value * (d1 - d0) +
      a.slope * (dampedDistanceIntegral(d1, interval) - dampedDistanceIntegral(d0, interval));
    const pieces: Piece[] = [];
    for (let i = 0; i + 1 < bounds.length; i += 1) {
      const from = bounds[i] as number;
      const to = bounds[i + 1] as number;
      const midDelta = Number.isFinite(to)
        ? (from + to) / 2 - a.measuredAt
        : from + 1 - a.measuredAt;
      const clamped = raw(midDelta) < this.min;
      pieces.push({
        from,
        to,
        quality: midDelta <= holdAt ? 'extrapolated' : 'held',
        integrate: (lo, hi) =>
          clamped ? this.min * (hi - lo) : rawIntegral(lo - a.measuredAt, hi - a.measuredAt),
      });
    }
    return pieces;
  }
}
