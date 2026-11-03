// SPDX-License-Identifier: Apache-2.0

/** A monotonic reading in epoch ms: what drives a live clock (the OS clock, a fake clock in tests). */
export interface TimeSource {
  now(): number;
}

/** Identifies a scheduled task for `cancel`. */
export type TaskId = number;

/**
 * The host's logical clock (docs/architecture/time-and-scheduling.md). Everything simulation-relevant
 * reads time and schedules work only through it:
 * - `now()` is constant during a processing turn: computing never advances logical time.
 * - A scheduled callback observes its planned time, however late it actually runs.
 * - At the same logical time, scheduled tasks run before external inputs.
 */
export interface Clock extends TimeSource {
  /** Runs `callback` in its own turn at `timestamp` (the current time, if that has passed). */
  scheduleAt(timestamp: number, callback: () => void): TaskId;
  /** Runs `callback` at `now() + interval`, `+ 2·interval`, …: planned from the first, never from wake-ups. */
  scheduleEvery(interval: number, callback: () => void): TaskId;
  cancel(taskId: TaskId): void;
}
