// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  Workout,
  WorkoutCue,
  WorkoutDuration,
  WorkoutEffort,
  WorkoutIntensity,
  WorkoutStep,
} from '@ridrs/contracts';

/**
 * The assumptions behind estimated lengths. A step that does not end by time can only be guessed
 * before it is ridden; the guess is deterministic and every segment it touches is marked.
 */
export interface TimelineOptions {
  /** m/s for distance steps: 30 km/h by default, a steady pace on the flat. */
  readonly speedMetersPerSecond?: number;
  /**
   * W for energy steps (FIT calories). 1 kcal burnt is about 1 kJ of work: a gross efficiency of
   * about 24 % cancels the 4.184 kJ per kcal. 150 W by default.
   */
  readonly energyWatts?: number;
  /** s for a step that ends by the lap button: 5 minutes by default. */
  readonly openSeconds?: number;
  /** s for a step that ends once a value passes a bound: 5 minutes by default. */
  readonly untilSeconds?: number;
}

export const TIMELINE_DEFAULTS: Required<TimelineOptions> = {
  speedMetersPerSecond: 30 / 3.6,
  energyWatts: 150,
  openSeconds: 300,
  untilSeconds: 300,
};

/** Where a segment lies in a repeat, outermost first. */
export interface RepeatPosition {
  readonly repeatId: string;
  /** 1-based. */
  readonly iteration: number;
  /** The count of a counted repeat; absent for one that ends otherwise, unrolled once. */
  readonly count?: number;
}

/** One interval step as ridden once: a repeat's steps appear once per round. */
export interface TimelineSegment {
  /** 0-based position in the timeline. */
  readonly index: number;
  readonly stepId: string;
  readonly name?: string;
  readonly repeats: readonly RepeatPosition[];
  readonly startSeconds: number;
  readonly durationSeconds: number;
  /** The length is estimated (distance, energy, lap button, `until`). */
  readonly estimated: boolean;
  /** As the step states it, e.g. for the player to wait for the lap button. */
  readonly duration: WorkoutDuration;
  readonly effort: WorkoutEffort;
  readonly intensity?: WorkoutIntensity;
  /** Offsets from the start of the segment. */
  readonly cues: readonly WorkoutCue[];
}

export interface WorkoutTimeline {
  readonly segments: readonly TimelineSegment[];
  readonly durationSeconds: number;
  /** Some length is estimated, or a repeat that ends otherwise than by a count ran once. */
  readonly estimated: boolean;
}

/** The length of a duration and whether it is estimated. */
export function durationOf(
  duration: WorkoutDuration,
  options: TimelineOptions = {},
): { readonly seconds: number; readonly estimated: boolean } {
  const assume = { ...TIMELINE_DEFAULTS, ...options };
  switch (duration.kind) {
    case 'time':
      return { seconds: duration.seconds, estimated: false };
    case 'distance':
      return { seconds: duration.meters / assume.speedMetersPerSecond, estimated: true };
    case 'energy':
      return { seconds: (duration.kilocalories * 1000) / assume.energyWatts, estimated: true };
    case 'open':
      return { seconds: assume.openSeconds, estimated: true };
    case 'until':
      return { seconds: assume.untilSeconds, estimated: true };
  }
}

/** Unrolls the steps of a workout into the segments a ride goes through, in order. */
export function workoutTimeline(workout: Workout, options: TimelineOptions = {}): WorkoutTimeline {
  const segments: TimelineSegment[] = [];
  let at = 0;
  let estimated = false;

  const walk = (steps: readonly WorkoutStep[], repeats: readonly RepeatPosition[]) => {
    for (const step of steps) {
      if (step.kind === 'repeat') {
        const count = step.until.kind === 'count' ? step.until.reps : undefined;
        if (count === undefined) estimated = true;
        for (let iteration = 1; iteration <= (count ?? 1); iteration++) {
          const position = {
            repeatId: step.id,
            iteration,
            ...(count === undefined ? {} : { count }),
          };
          walk(step.steps, [...repeats, position]);
        }
        continue;
      }
      const length = durationOf(step.duration, options);
      estimated ||= length.estimated;
      segments.push({
        index: segments.length,
        stepId: step.id,
        ...(step.name === undefined ? {} : { name: step.name }),
        repeats,
        startSeconds: at,
        durationSeconds: length.seconds,
        estimated: length.estimated,
        duration: step.duration,
        effort: step.effort,
        ...(step.intensity === undefined ? {} : { intensity: step.intensity }),
        cues: step.cues ?? [],
      });
      at += length.seconds;
    }
  };

  walk(workout.steps, []);
  return { segments, durationSeconds: at, estimated };
}

export interface SegmentPosition {
  readonly segment: TimelineSegment;
  /** s since the start of the segment. */
  readonly offsetSeconds: number;
  readonly remainingSeconds: number;
}

/**
 * The segment at a moment of the workout, for the player and the HUD: a segment holds from its
 * start up to, not including, its end. Undefined before the start and from the end on.
 */
export function segmentAt(timeline: WorkoutTimeline, seconds: number): SegmentPosition | undefined {
  const { segments } = timeline;
  let low = 0;
  let high = segments.length - 1;
  // The last segment starting at or before `seconds`; zero-length segments are passed over.
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if ((segments[middle]?.startSeconds ?? 0) <= seconds) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  const segment = segments[found];
  if (!segment || seconds < 0) return undefined;
  const offsetSeconds = seconds - segment.startSeconds;
  if (offsetSeconds >= segment.durationSeconds) return undefined;
  return { segment, offsetSeconds, remainingSeconds: segment.durationSeconds - offsetSeconds };
}
