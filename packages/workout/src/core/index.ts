// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The core of `@ridrs/workout` (structured-workouts.md, sections 4, 5, 6, 11a): validation,
 * the timeline, resolving targets, zones, metrics and the chart geometry. Pure, headless and
 * deterministic: no clock, no randomness, no I/O.
 */
export {
  ASSUMED_FTP_WATTS,
  INTENSITY_ESTIMATES,
  type IntensityContext,
  type IntensityEstimates,
  type IntensityMarker,
  intensityContext,
  type PowerBasis,
  powerBasis,
  type SegmentIntensity,
  segmentIntensity,
} from './intensity.ts';
export {
  CHART_MAX_PERCENT,
  type ChartBracket,
  type ChartPoint,
  type ChartShape,
  type ChartSummary,
  type ChartTick,
  type LayoutOptions,
  layoutWorkout,
  type WorkoutChartVariant,
  type WorkoutLayout,
} from './layout.ts';
export {
  type MetricsOptions,
  normalizedPower,
  type WorkoutMetrics,
  workoutMetrics,
} from './metrics.ts';
export {
  isHeartRateUnit,
  isPowerUnit,
  type ResolveFailure,
  type ResolveIssue,
  resolveTarget,
  resolveWorkout,
  type TargetResolution,
  type WorkoutAthlete,
  type WorkoutResolution,
} from './resolve.ts';
export {
  durationOf,
  type RepeatPosition,
  type SegmentPosition,
  segmentAt,
  TIMELINE_DEFAULTS,
  type TimelineOptions,
  type TimelineSegment,
  type WorkoutTimeline,
  workoutTimeline,
} from './timeline.ts';
export { MAX_PERCENT_FTP, MAX_REPEATS, validateWorkout } from './validate.ts';
export {
  defaultHeartRateZones,
  defaultPowerZones,
  type TrainingZones,
  zoneBounds,
  zoneOf,
} from './zones.ts';
