// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MotionCapability, MotionResult, PhysicsState } from '@ridrs/contracts';

export const ENGINE_DEFAULTS = Object.freeze({
  /** Fixed simulation step, 100 Hz. */
  stepMs: 10,
  /** `physics.state` goes out at step 0 and every this many steps (250 ms), plus at finish. */
  publishEverySteps: 25,
  /** At most this many steps per wake, so a long catch-up never blocks the event loop in one piece. */
  maxStepsPerWake: 1000,
});

/** The time of state `step`: from the index, never by repeated addition. */
export function stepTime(startedAt: number, step: number): number {
  return startedAt + ENGINE_DEFAULTS.stepMs * step;
}

/**
 * One ride's simulation, free of timers: the engine decides when to run it, this decides what to
 * compute. Step times and order depend only on the start time and the clock reading, never on
 * when the host gets to run it.
 */
export class RideSimulation {
  private current: MotionResult;
  private step = 0;
  private lastPublishedStep = -1;

  constructor(
    readonly sessionId: string,
    readonly startedAt: number,
    private readonly motion: MotionCapability,
    private readonly publish: (state: PhysicsState) => void,
  ) {
    this.current = motion.initial(startedAt);
    this.emit();
  }

  /** When the next step is due. */
  nextDueAt(): number {
    return stepTime(this.startedAt, this.step + 1);
  }

  /** Computes due steps with `t <= until`, at most `limit`; returns whether more are due. */
  advanceUntil(until: number, limit = Number.POSITIVE_INFINITY): boolean {
    for (let done = 0; done < limit && this.nextDueAt() <= until; done += 1) {
      this.current = this.motion.advance(this.current, this.nextDueAt());
      this.step += 1;
      if (this.step % ENGINE_DEFAULTS.publishEverySteps === 0) {
        this.emit();
      }
    }
    return this.nextDueAt() <= until;
  }

  /** The final state, unless it already went out. */
  finish(endedAt: number): void {
    this.advanceUntil(endedAt);
    if (this.lastPublishedStep !== this.step) {
      this.emit();
    }
  }

  /** The step the next advance computes; while one fails, the failing step. */
  nextStep(): number {
    return this.step + 1;
  }

  private emit(): void {
    this.lastPublishedStep = this.step;
    this.publish({ ...this.current, sessionId: this.sessionId, step: this.step });
  }
}
