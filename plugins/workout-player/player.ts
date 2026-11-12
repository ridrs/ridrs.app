// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Workout, WorkoutEffort, WorkoutRange } from '@ridrs/contracts';
import { type TimelineSegment, workoutTimeline } from '@ridrs/workout';

/** The values an `until` step compares, by the unit its condition names. */
export type ConditionUnit = 'watts' | 'bpm' | 'rpm';

/** Where the ride is, as the player sees it at one moment. */
export interface Progress {
  /** ms the ride ran: a pause does not count. */
  readonly ridden: number;
  /** m, the virtual distance. */
  readonly distance: number;
  /** J of work, from the measured power. */
  readonly work: number;
  /** The latest measured values, for `until` steps. */
  readonly values: Readonly<Partial<Record<ConditionUnit, number>>>;
}

/** A step began: its place in the unrolled timeline and its id in the workout. */
export interface StepBegan {
  readonly index: number;
  readonly stepId: string;
}

/** Where the current step began. */
interface Current {
  readonly segment: TimelineSegment;
  readonly ridden: number;
  readonly distance: number;
  readonly work: number;
}

const middle = (range: WorkoutRange) => (range.low + range.high) / 2;

/**
 * The power the trainer holds in ERG for a step: its primary target in watts, the middle of a
 * range, a ramp from the start to the end. Undefined for a step without one (a free ride, max
 * effort, a heart rate or cadence target): ERG is off there.
 */
export function ergTarget(effort: WorkoutEffort): { start: number; end?: number } | undefined {
  if (effort.kind !== 'target' || effort.primary.unit !== 'watts') {
    return undefined;
  }
  const { start, end } = effort.primary;
  return end ? { start: middle(start), end: middle(end) } : { start: middle(start) };
}

/**
 * One ride through a workout (structured-workouts.md, section 11a): the unrolled steps of
 * `workoutTimeline`, the step the ride is in and where it began. Pure: it knows no clock, no bus
 * and no trainer, only the progress it is given. Time steps end exactly at their length, so the
 * workout does not drift however late the progress arrives; a distance step ends by the virtual
 * distance, an energy step by the work (1 kcal burnt is about 1 kJ of work, as the timeline
 * assumes), an `until` step once its value passes the bound, an open step only by `skip`.
 */
export class WorkoutRun {
  readonly segments: readonly TimelineSegment[];
  private current: Current | undefined;
  private over = false;

  constructor(workout: Workout) {
    this.segments = workoutTimeline(workout).segments;
  }

  /** The step the ride is in; undefined before the start and once the workout is over. */
  get step(): TimelineSegment | undefined {
    return this.current?.segment;
  }

  get finished(): boolean {
    return this.over;
  }

  /** Begins the first step, and passes every step that ends at once. */
  begin(progress: Progress): StepBegan[] {
    if (this.current || this.over) {
      return [];
    }
    return [...this.enter(0, progress), ...this.advance(progress)];
  }

  /** Passes every step that ended by `progress`, in order. */
  advance(progress: Progress): StepBegan[] {
    const began: StepBegan[] = [];
    let current = this.current;
    while (current && !this.over) {
      const end = this.endOf(current, progress);
      if (end === undefined) {
        break;
      }
      began.push(...this.enter(current.segment.index + 1, { ...progress, ridden: end }));
      current = this.current;
    }
    return began;
  }

  /** "Next step": the current step ends now, whatever its duration. */
  skip(progress: Progress): StepBegan[] {
    const current = this.current;
    if (!current || this.over) {
      return [];
    }
    return [...this.enter(current.segment.index + 1, progress), ...this.advance(progress)];
  }

  /** The ERG target now, in whole watts; null where ERG is off or the workout is over. */
  target(progress: Progress): number | null {
    const current = this.current;
    const erg = current && !this.over ? ergTarget(current.segment.effort) : undefined;
    if (!current || !erg) {
      return null;
    }
    if (erg.end === undefined) {
      return Math.round(erg.start);
    }
    const share = Math.min(1, Math.max(0, this.shareOf(current, progress)));
    return Math.round(erg.start + (erg.end - erg.start) * share);
  }

  private enter(index: number, progress: Progress): StepBegan[] {
    const segment = this.segments[index];
    if (!segment) {
      this.current = undefined;
      this.over = true;
      return [];
    }
    this.current = {
      segment,
      ridden: progress.ridden,
      distance: progress.distance,
      work: progress.work,
    };
    return [{ index: segment.index, stepId: segment.stepId }];
  }

  /** The ridden time the step ended at, or undefined while it goes on. */
  private endOf(current: Current, progress: Progress): number | undefined {
    const { duration } = current.segment;
    switch (duration.kind) {
      case 'time': {
        const end = current.ridden + duration.seconds * 1000;
        return progress.ridden >= end ? end : undefined;
      }
      case 'distance':
        return progress.distance - current.distance >= duration.meters ? progress.ridden : undefined;
      case 'energy':
        return (progress.work - current.work) / 1000 >= duration.kilocalories
          ? progress.ridden
          : undefined;
      case 'open':
        return undefined;
      case 'until': {
        const value = progress.values[duration.unit as ConditionUnit];
        if (value === undefined) {
          return undefined;
        }
        const passed = duration.comparison === 'above' ? value > duration.value : value < duration.value;
        return passed ? progress.ridden : undefined;
      }
    }
  }

  /** How much of the step is done, for a ramp: 0 for a step whose end cannot be known. */
  private shareOf(current: Current, progress: Progress): number {
    const { duration } = current.segment;
    const of = (done: number, whole: number) => (whole > 0 ? done / whole : 0);
    switch (duration.kind) {
      case 'time':
        return of(progress.ridden - current.ridden, duration.seconds * 1000);
      case 'distance':
        return of(progress.distance - current.distance, duration.meters);
      case 'energy':
        return of((progress.work - current.work) / 1000, duration.kilocalories);
      default:
        return 0;
    }
  }
}
