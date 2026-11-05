// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Clock, TaskId, TimeSource } from '@ridrs/contracts';

/**
 * The OS's monotonic clock on the epoch axis, in whole ms: `performance.timeOrigin + now()` never
 * jumps back with wall-clock adjustments. Node and every WebView have `performance`.
 */
export function createSystemTimeSource(): TimeSource {
  return { now: () => Math.floor(performance.timeOrigin + performance.now()) };
}

/** The timers a live clock arms to wake up; global timers by default (fake ones in tests). */
export interface TimerPort {
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
}

interface Task {
  readonly id: TaskId;
  /** Planned logical time. */
  due: number;
  /** Scheduling order; breaks ties between tasks due at the same time. */
  seq: number;
  readonly interval?: number;
  readonly callback: () => void;
}

interface QueuedInput {
  readonly at: number;
  readonly seq: number;
  readonly run: () => void;
}

/** A turn that failed: the queue goes on, the host reports it. */
export type TurnErrorHandler = (error: unknown, turn: 'task' | 'input') => void;

/**
 * The deterministic turn queue shared by `LiveClock` and `ReplayClock`. A turn is one queue item:
 * a scheduled task or an external input, run synchronously with everything it publishes. Items run
 * in the order of `(logical time, tasks before inputs, sequence number)`; the logical time is
 * constant during a turn and never decreases. Logical timestamps are never shifted: ties are
 * resolved by that order alone.
 */
export abstract class TurnClock implements Clock {
  private readonly tasks = new Map<TaskId, Task>();
  private readonly inputs: QueuedInput[] = [];
  private nextTaskId = 1;
  private taskSeq = 0;
  private inputSeq = 0;
  /** Logical time of the running turn. */
  private current: number | undefined;
  private pumping = false;
  protected last: number;
  onError: TurnErrorHandler = () => undefined;

  protected constructor(start: number) {
    this.last = start;
  }

  /** The time new work is placed at outside a turn. */
  protected abstract outsideNow(): number;
  /** How far the queue may run now. */
  protected abstract horizon(): number;
  /** Called after the queue ran: a live clock arms its timer for `nextDue`. */
  protected abstract idle(nextDue: number | undefined): void;
  /** A live clock yields after this many turns so a long catch-up never blocks the event loop. */
  protected abstract shouldYield(turns: number): boolean;

  now(): number {
    return this.current ?? Math.max(this.last, this.outsideNow());
  }

  inTurn(): boolean {
    return this.current !== undefined;
  }

  scheduleAt(timestamp: number, callback: () => void): TaskId {
    return this.addTask(timestamp, callback, undefined);
  }

  scheduleEvery(interval: number, callback: () => void): TaskId {
    if (!(interval > 0)) {
      throw new RangeError(`Interval must be positive, got ${interval}`);
    }
    return this.addTask(this.now() + interval, callback, interval);
  }

  cancel(taskId: TaskId): void {
    if (this.tasks.delete(taskId) && !this.pumping) {
      this.idle(this.nextDue());
    }
  }

  /**
   * Queues an external input at `at` (default: now) and runs the queue. Inputs keep their order of
   * arrival; one at time t runs after every task due at or before t.
   */
  enqueueInput(run: () => void, at = this.now()): void {
    this.inputSeq += 1;
    this.inputs.push({ at: Math.max(at, this.last), seq: this.inputSeq, run });
    this.pump();
  }

  /** Scheduled tasks, for tests and diagnostics. */
  pendingTasks(): number {
    return this.tasks.size;
  }

  private addTask(due: number, callback: () => void, interval: number | undefined): TaskId {
    const id = this.nextTaskId;
    this.nextTaskId += 1;
    this.taskSeq += 1;
    // A time that has passed means "as soon as possible": never before the current logical time.
    this.tasks.set(id, {
      id,
      due: Math.max(due, this.now()),
      seq: this.taskSeq,
      interval,
      callback,
    });
    if (!this.pumping) {
      this.idle(this.nextDue());
    }
    return id;
  }

  private nextDue(): number | undefined {
    let next: number | undefined;
    for (const task of this.tasks.values()) {
      next = next === undefined ? task.due : Math.min(next, task.due);
    }
    return next;
  }

  private nextTask(): Task | undefined {
    let next: Task | undefined;
    for (const task of this.tasks.values()) {
      if (!next || task.due < next.due || (task.due === next.due && task.seq < next.seq)) {
        next = task;
      }
    }
    return next;
  }

  /** Runs every item that is due, in order; re-entrant calls (inputs during a turn) just queue. */
  protected pump(): void {
    if (this.pumping) {
      return;
    }
    this.pumping = true;
    let turns = 0;
    try {
      for (;;) {
        const horizon = this.horizon();
        const task = this.nextTask();
        const input = this.inputs[0];
        const taskReady = task !== undefined && task.due <= horizon;
        const inputReady = input !== undefined && input.at <= horizon;
        if (!taskReady && !inputReady) {
          break;
        }
        if (this.shouldYield(turns)) {
          return;
        }
        turns += 1;
        if (taskReady && (!inputReady || task.due <= input.at)) {
          this.runTask(task);
        } else if (input) {
          this.inputs.shift();
          this.runTurn(input.at, input.run, 'input');
        }
      }
    } finally {
      this.pumping = false;
    }
    this.idle(this.nextDue());
  }

  private runTask(task: Task): void {
    if (task.interval === undefined) {
      this.tasks.delete(task.id);
    } else {
      // The next run is planned from this run's plan, never from when it actually ran.
      this.taskSeq += 1;
      this.tasks.set(task.id, { ...task, due: task.due + task.interval, seq: this.taskSeq });
    }
    this.runTurn(task.due, task.callback, 'task');
  }

  private runTurn(at: number, run: () => void, turn: 'task' | 'input'): void {
    this.current = at;
    try {
      run();
    } catch (error) {
      this.onError(error, turn);
    } finally {
      this.current = undefined;
      this.last = at;
    }
  }
}

export interface LiveClockOptions {
  readonly timeSource?: TimeSource;
  readonly timers?: TimerPort;
  /** Turns per chunk before yielding to the event loop during a catch-up. */
  readonly turnsPerChunk?: number;
  /**
   * Starts held at this time (ADR 0057): like a replay clock, time moves only by `advanceTo`,
   * with no timers, until `release` hands it to the time source.
   */
  readonly heldAt?: number;
}

/**
 * The live clock: driven by a monotonic time source, woken by one timer for the next due task. A
 * late wake runs every overdue task at its planned time, in order, in chunks; inputs that arrive
 * meanwhile wait for the tasks due before them.
 */
export class LiveClock extends TurnClock {
  private readonly source: TimeSource;
  private readonly timers: TimerPort;
  private readonly turnsPerChunk: number;
  private wake: { readonly handle: unknown; readonly due: number } | undefined;
  /** One reading per synchronous run outside turns: preparing an input does not advance time. */
  private reading: number | undefined;
  /** While held, the time `advanceTo` reached. */
  private held: { target: number } | undefined;

  constructor(options: LiveClockOptions = {}) {
    const source = options.timeSource ?? createSystemTimeSource();
    super(options.heldAt ?? source.now());
    this.held = options.heldAt === undefined ? undefined : { target: options.heldAt };
    this.source = source;
    this.timers = options.timers ?? {
      setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
      clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    this.turnsPerChunk = options.turnsPerChunk ?? 1000;
  }

  protected outsideNow(): number {
    if (this.held) {
      return this.held.target;
    }
    if (this.reading === undefined) {
      this.reading = this.source.now();
      queueMicrotask(() => {
        this.reading = undefined;
      });
    }
    return this.reading;
  }

  protected horizon(): number {
    return this.held ? this.held.target : Math.max(this.last, this.source.now());
  }

  protected shouldYield(turns: number): boolean {
    if (this.held || turns < this.turnsPerChunk) {
      return false;
    }
    this.arm(this.source.now());
    return true;
  }

  protected idle(nextDue: number | undefined): void {
    if (this.held) {
      return;
    }
    if (nextDue === undefined) {
      this.disarm();
      return;
    }
    this.arm(nextDue);
  }

  isHeld(): boolean {
    return this.held !== undefined;
  }

  /** While held: moves logical time to `time`, running every task and input due by then. */
  advanceTo(time: number): void {
    const held = this.held;
    if (!held) {
      throw new Error('advanceTo needs a held clock');
    }
    held.target = Math.max(held.target, time);
    this.pump();
    this.last = Math.max(this.last, held.target);
  }

  /**
   * Hands the clock to its time source: logical time goes on from the time source's reading, and
   * the tasks due in between run at their planned times (ADR 0057).
   */
  release(): void {
    if (!this.held) {
      return;
    }
    this.held = undefined;
    this.pump();
  }

  /** Stops waking up; scheduled tasks stay. For host disposal. */
  dispose(): void {
    this.disarm();
  }

  private arm(due: number): void {
    if (this.wake?.due === due) {
      return;
    }
    this.disarm();
    const handle = this.timers.setTimeout(
      () => {
        this.wake = undefined;
        this.pump();
      },
      Math.max(0, due - this.source.now()),
    );
    this.wake = { handle, due };
  }

  private disarm(): void {
    if (this.wake) {
      this.timers.clearTimeout(this.wake.handle);
      this.wake = undefined;
    }
  }
}

/**
 * The replay clock: no timers and no time source. Time moves only when the replay calls
 * `advanceTo`, which runs every task and recorded input due by then, in the same order as live.
 */
export class ReplayClock extends TurnClock {
  private target: number;

  constructor(start: number) {
    super(start);
    this.target = start;
  }

  protected outsideNow(): number {
    return this.target;
  }

  protected horizon(): number {
    return this.target;
  }

  protected shouldYield(): boolean {
    return false;
  }

  protected idle(): void {}

  advanceTo(time: number): void {
    this.target = Math.max(this.target, time);
    this.pump();
    this.last = Math.max(this.last, this.target);
  }
}
