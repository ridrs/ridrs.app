// SPDX-License-Identifier: AGPL-3.0-or-later

// Pure, deterministic math of the temporal data layer: no clock, no timers, no I/O. The core
// (`ctx.temporal`) owns time and lifecycles; plugins never import this package.
export { dampedDistance, dampedDistanceIntegral, dampedDistanceInverse } from './damping.ts';
export { TEMPORAL_DEFAULTS } from './defaults.ts';
export { IntervalEstimator } from './intervals.ts';
export {
  type FreshnessTransition,
  staleAfterFor,
  TemporalSeries,
  type TemporalSeriesOptions,
} from './series.ts';
export { buildSnapshot } from './snapshot.ts';
