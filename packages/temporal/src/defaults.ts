// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The Phase 4 behavior of every series. `T` is the learned sampling interval. The features rely
 * on these numbers; see docs/architecture/temporal-data-layer.md.
 */
export const TEMPORAL_DEFAULTS = Object.freeze({
  /** T is the median of the last 8 accepted intervals ... */
  intervalWindow: 8,
  /** ... once 3 intervals (4 measurements) were accepted. */
  learnedAfterIntervals: 3,
  /** Once learned, an interval above 2.5 T is a gap, not a new rate. */
  outlierFactor: 2.5,
  /** 3 consecutive outliers within ±20 % of their own median replace the window. */
  sustainedChangeCount: 3,
  sustainedChangeTolerance: 0.2,
  /** Stale threshold while T is not learned (identical to Phase 2). */
  fallbackStaleAfterMs: 3000,
  /** Delayed from 1.5 T since the last receive. */
  delayedAfterIntervals: 1.5,
  /** Stale from clamp(8 T, 2000 ms, 10000 ms) since the last receive. */
  staleAfterIntervals: 8,
  minStaleAfterMs: 2000,
  maxStaleAfterMs: 10_000,
  /** Trend: least-squares slope over 4 T before the last measurement, from at least 3 measurements. */
  trendWindowIntervals: 4,
  minTrendMeasurements: 3,
  /** The trend runs fully for 1 T, then decays with τ = T and is held from 3 T. */
  holdAfterIntervals: 3,
  /** History per series: 60 s by measurement time, at most 600 measurements. */
  historyMs: 60_000,
  historyMaxEntries: 600,
  /** Estimates never go below this. */
  minValue: 0,
});
