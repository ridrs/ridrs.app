// SPDX-License-Identifier: AGPL-3.0-or-later

import type { WorkoutInterval, WorkoutStructure } from '@tabata-sync/contracts';

/** Where a playback position falls in the workout. Derived from the position only, never from a timer. */
export interface WorkoutPosition {
  readonly interval: WorkoutInterval | undefined;
  readonly elapsedSec: number;
  readonly remainingSec: number;
  readonly next: WorkoutInterval | undefined;
  /** Round of the current or most recent work interval, 0 before the first. */
  readonly round: number;
  readonly totalRounds: number;
  readonly completedRounds: number;
  /** Share of the workout (first work start to workout end) already played, 0..1. */
  readonly workoutProgress: number;
}

export function positionAt(structure: WorkoutStructure, timeSec: number): WorkoutPosition {
  const intervals = structure.intervals;
  let index = intervals.findIndex((i) => timeSec >= i.startSec && timeSec < i.endSec);
  if (index < 0 && intervals.length > 0 && timeSec >= (intervals.at(-1) as WorkoutInterval).endSec) index = intervals.length - 1;
  const interval = index >= 0 ? intervals[index] : undefined;
  const work = intervals.filter((i) => i.type === 'work');
  const started = work.filter((i) => i.startSec <= timeSec);
  const completed = work.filter((i) => i.endSec <= timeSec);
  const start = structure.workoutStartSec ?? work[0]?.startSec;
  const end = structure.workoutEndSec ?? work.at(-1)?.endSec;
  const progress = start !== undefined && end !== undefined && end > start ? (timeSec - start) / (end - start) : 0;
  return {
    interval,
    elapsedSec: interval ? Math.max(0, timeSec - interval.startSec) : 0,
    remainingSec: interval ? Math.max(0, interval.endSec - timeSec) : 0,
    next: index >= 0 ? intervals[index + 1] : intervals[0],
    round: started.length,
    totalRounds: work.length,
    completedRounds: completed.length,
    workoutProgress: Math.min(1, Math.max(0, progress)),
  };
}
