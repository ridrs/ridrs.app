// SPDX-License-Identifier: AGPL-3.0-or-later

import type { WORKOUT_CHART_VARIANTS, Workout } from '@ridrs/contracts';
import {
  type IntensityMarker,
  intensityContext,
  middle,
  type PowerBasis,
  segmentIntensity,
} from './intensity.ts';
import { workoutMetrics } from './metrics.ts';
import type { WorkoutAthlete } from './resolve.ts';
import { workoutTimeline } from './timeline.ts';
import { defaultPowerZones, zoneOf } from './zones.ts';

/**
 * The geometry of the workout chart (structured-workouts.md, section 5.1), plain data for the
 * chart, the editor and the HUD: no DOM and no words. Width is time; height is intensity, on a
 * fixed scale of 0–150 % FTP so that workouts compare, or on a watt axis for a workout in watts
 * without an FTP. y grows downwards (0 is the top), as in SVG.
 */

export type WorkoutChartVariant = (typeof WORKOUT_CHART_VARIANTS)[number];

export interface LayoutOptions {
  readonly width: number;
  readonly height: number;
  readonly athlete?: WorkoutAthlete;
  /** `full` by default. `micro` is a silhouette; axes and brackets only in `full` and `edit`. */
  readonly variant?: WorkoutChartVariant;
}

export type ChartPoint = readonly [x: number, y: number];

export interface ChartShape {
  readonly segmentIndex: number;
  readonly stepId: string;
  readonly x0: number;
  readonly x1: number;
  /**
   * From the baseline up to the target (a range at its middle), clockwise from the bottom left:
   * a rectangle for a steady step, a trapezoid for a ramp.
   */
  readonly polygon: readonly ChartPoint[];
  /** A range: the band between its low and high values, from the top left, clockwise. */
  readonly band?: readonly ChartPoint[];
  readonly ramp: boolean;
  /** The 1-based power zone of its mean height, for its colour; absent: neutral (no FTP). */
  readonly zone?: number;
  /** Drawn hatched: no power target, or a length that ends by the lap button or a condition. */
  readonly marker?: IntensityMarker;
  readonly heightEstimated: boolean;
  readonly widthEstimated: boolean;
  /** A value lies above the axis and is drawn at its top. */
  readonly clipped: boolean;
}

export interface ChartTick {
  readonly value: number;
  /** The x of a time tick or the y of an intensity tick. */
  readonly at: number;
  /** W beside % FTP, when the FTP is known. */
  readonly watts?: number;
}

export interface ChartBracket {
  readonly repeatId: string;
  /** Absent for a repeat that ends otherwise than by a count (drawn once). */
  readonly count?: number;
  readonly x0: number;
  readonly x1: number;
  /** 0 for an outermost repeat. */
  readonly depth: number;
}

/** What the accessible description says, as numbers: the chart plugin words them. */
export interface ChartSummary {
  readonly durationSeconds: number;
  readonly durationEstimated: boolean;
  /** The main set: the most time spent in equal steps above the mean intensity. */
  readonly mainIntervals?: {
    readonly count: number;
    readonly durationSeconds: number;
    /** In the axis unit. */
    readonly value: number;
  };
  readonly intensityFactor?: number;
  readonly trainingLoad?: number;
}

export interface WorkoutLayout {
  readonly width: number;
  readonly height: number;
  readonly durationSeconds: number;
  readonly axis: {
    readonly unit: PowerBasis;
    readonly max: number;
    /** Empty in the variants without axes. */
    readonly ticks: readonly ChartTick[];
  };
  readonly timeTicks: readonly ChartTick[];
  /** The dashed line at 100 % FTP; absent on a watt axis and in `micro`. */
  readonly ftpLine?: { readonly y: number };
  /** The shapes have zones: the FTP is known. */
  readonly zoned: boolean;
  readonly shapes: readonly ChartShape[];
  readonly brackets: readonly ChartBracket[];
  readonly summary: ChartSummary;
}

/** The fixed top of the % axis. */
export const CHART_MAX_PERCENT = 150;
const PERCENT_TICK = 50;
const WATT_ROUNDING = 50;
const LARGEST_WATT_TICK = 1000;
const WATT_TICKS = [50, 100, 200, 250, 500, LARGEST_WATT_TICK] as const;
const TIME_TICKS = [15, 30, 60, 120, 300, 600, 900, 1200, 1800, 3600, 7200] as const;
const MAX_TICKS = 8;
const PLAIN = new Set(['warm-up', 'cool-down', 'rest', 'recovery']);

const memory = new WeakMap<Workout, Map<string, WorkoutLayout>>();

/**
 * Lays a workout out for a chart of `width` × `height`. Remembered per workout object and size
 * (and athlete and variant), so that 50 calendar entries cost one layout each.
 */
export function layoutWorkout(workout: Workout, options: LayoutOptions): WorkoutLayout {
  const { athlete = {}, variant = 'full' } = options;
  const key = JSON.stringify([
    options.width,
    options.height,
    variant,
    athlete.ftp,
    athlete.powerZones,
    athlete.lthr,
    athlete.maxHeartRate,
    athlete.heartRateZones,
  ]);
  let byKey = memory.get(workout);
  if (!byKey) {
    byKey = new Map();
    memory.set(workout, byKey);
  }
  const known = byKey.get(key);
  if (known) return known;
  const layout = lay(workout, options.width, options.height, athlete, variant);
  byKey.set(key, layout);
  return layout;
}

function lay(
  workout: Workout,
  width: number,
  height: number,
  athlete: WorkoutAthlete,
  variant: WorkoutChartVariant,
): WorkoutLayout {
  const timeline = workoutTimeline(workout);
  const context = intensityContext(workout, athlete);
  const intensities = timeline.segments.map((segment) => segmentIntensity(segment, context));
  const ftp = athlete.ftp;
  const zones = ftp ? (athlete.powerZones ?? defaultPowerZones()) : undefined;
  const total = timeline.durationSeconds;

  const max =
    context.basis === 'percent-ftp'
      ? CHART_MAX_PERCENT
      : workout.referenceFtp
        ? (workout.referenceFtp * CHART_MAX_PERCENT) / 100
        : Math.max(
            WATT_ROUNDING * 2,
            Math.ceil(
              (Math.max(0, ...intensities.flatMap((each) => [each.start.high, each.end.high])) *
                1.1) /
                WATT_ROUNDING,
            ) * WATT_ROUNDING,
          );
  const x = (seconds: number) => (total > 0 ? (seconds / total) * width : 0);
  const y = (value: number) => height - (Math.min(Math.max(value, 0), max) / max) * height;

  const shapes = timeline.segments.map((segment, index): ChartShape => {
    const intensity = intensities[index] ?? segmentIntensity(segment, context);
    const x0 = x(segment.startSeconds);
    const x1 = x(segment.startSeconds + segment.durationSeconds);
    const start = middle(intensity.start);
    const end = middle(intensity.end);
    const isRange =
      intensity.start.low !== intensity.start.high || intensity.end.low !== intensity.end.high;
    return {
      segmentIndex: index,
      stepId: segment.stepId,
      x0,
      x1,
      polygon: [
        [x0, height],
        [x0, y(start)],
        [x1, y(end)],
        [x1, height],
      ],
      ...(isRange
        ? {
            band: [
              [x0, y(intensity.start.high)],
              [x1, y(intensity.end.high)],
              [x1, y(intensity.end.low)],
              [x0, y(intensity.start.low)],
            ] as const,
          }
        : {}),
      ramp: intensity.ramp,
      // With an FTP the basis is % FTP; a ramp takes the zone of its mean.
      ...(zones && intensity.power ? { zone: zoneOf((start + end) / 2, zones) } : {}),
      ...(intensity.marker ? { marker: intensity.marker } : {}),
      heightEstimated: intensity.estimated,
      widthEstimated: segment.estimated,
      clipped: Math.max(intensity.start.high, intensity.end.high) > max,
    };
  });

  const detailed = variant === 'full' || variant === 'edit';
  const ticks = detailed ? valueTicks(context.basis, max, ftp, y) : [];
  const timeTicks = detailed ? secondTicks(total, x) : [];

  const brackets = new Map<string, { -readonly [K in keyof ChartBracket]: ChartBracket[K] }>();
  if (detailed) {
    for (const shape of shapes) {
      const segment = timeline.segments[shape.segmentIndex];
      segment?.repeats.forEach((position, depth, positions) => {
        // An inner repeat gets a bracket per round of the repeats around it.
        const outer = positions.slice(0, depth).map((each) => each.iteration);
        const key = JSON.stringify([position.repeatId, ...outer]);
        const found = brackets.get(key);
        if (found) {
          found.x0 = Math.min(found.x0, shape.x0);
          found.x1 = Math.max(found.x1, shape.x1);
        } else {
          brackets.set(key, {
            repeatId: position.repeatId,
            ...(position.count === undefined ? {} : { count: position.count }),
            x0: shape.x0,
            x1: shape.x1,
            depth,
          });
        }
      });
    }
  }

  const metrics = workoutMetrics(workout, athlete);
  const mainIntervals = mainSet(timeline.segments, intensities);
  return {
    width,
    height,
    durationSeconds: total,
    axis: { unit: context.basis, max, ticks },
    timeTicks,
    ...(context.basis === 'percent-ftp' && variant !== 'micro' ? { ftpLine: { y: y(100) } } : {}),
    zoned: zones !== undefined,
    shapes,
    brackets: [...brackets.values()],
    summary: {
      durationSeconds: total,
      durationEstimated: timeline.estimated,
      ...(mainIntervals ? { mainIntervals } : {}),
      ...(metrics.intensityFactor === undefined
        ? {}
        : { intensityFactor: metrics.intensityFactor }),
      ...(metrics.trainingLoad === undefined ? {} : { trainingLoad: metrics.trainingLoad }),
    },
  };
}

function valueTicks(
  basis: PowerBasis,
  max: number,
  ftp: number | undefined,
  y: (value: number) => number,
): ChartTick[] {
  const step =
    basis === 'percent-ftp'
      ? PERCENT_TICK
      : (WATT_TICKS.find((each) => max / each < 6) ?? LARGEST_WATT_TICK);
  const ticks: ChartTick[] = [];
  for (let value = 0; value <= max; value += step) {
    ticks.push({
      value,
      at: y(value),
      ...(basis === 'percent-ftp' && ftp ? { watts: Math.round((value * ftp) / 100) } : {}),
    });
  }
  return ticks;
}

/** Ticks on whole minutes or hours: at most eight steps over the workout. */
function secondTicks(total: number, x: (seconds: number) => number): ChartTick[] {
  if (total <= 0) return [];
  const step =
    TIME_TICKS.find((each) => total / each <= MAX_TICKS) ??
    Math.ceil(total / MAX_TICKS / 3600) * 3600;
  const ticks: ChartTick[] = [];
  for (let seconds = 0; seconds <= total; seconds += step)
    ticks.push({ value: seconds, at: x(seconds) });
  return ticks;
}

/**
 * The main set, for the accessible description ("3 intervals of 12 minutes at 90 %"): steady
 * steps with a power target that are not warm-up, cool-down or rest, grouped by length and
 * height; of the groups above the workout's mean intensity, the one with the most time.
 */
function mainSet(
  segments: ReturnType<typeof workoutTimeline>['segments'],
  intensities: readonly ReturnType<typeof segmentIntensity>[],
): ChartSummary['mainIntervals'] {
  let time = 0;
  let work = 0;
  const groups = new Map<string, { count: number; durationSeconds: number; value: number }>();
  segments.forEach((segment, index) => {
    const intensity = intensities[index];
    if (!intensity) return;
    const value = (middle(intensity.start) + middle(intensity.end)) / 2;
    time += segment.durationSeconds;
    work += value * segment.durationSeconds;
    if (!intensity.power || intensity.ramp || segment.estimated) return;
    if (segment.intensity && PLAIN.has(segment.intensity)) return;
    const key = `${Math.round(segment.durationSeconds)}|${Math.round(value * 10)}`;
    const group = groups.get(key) ?? { count: 0, durationSeconds: segment.durationSeconds, value };
    group.count++;
    groups.set(key, group);
  });
  const mean = time > 0 ? work / time : 0;
  let best: ChartSummary['mainIntervals'];
  for (const group of groups.values()) {
    if (group.value <= mean) continue;
    const better =
      !best ||
      group.count * group.durationSeconds > best.count * best.durationSeconds ||
      (group.count * group.durationSeconds === best.count * best.durationSeconds &&
        group.value > best.value);
    if (better) best = group;
  }
  return best;
}
