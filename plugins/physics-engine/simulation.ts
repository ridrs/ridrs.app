// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MotionCapability,
  MotionResult,
  PhysicsSample,
  PhysicsState,
  PhysicsStateBatch,
  TrainerLoadCapability,
  TrainerLoadSample,
} from '@ridrs/contracts';

export const ENGINE_DEFAULTS = Object.freeze({
  /** Fixed simulation step, 100 Hz. */
  stepMs: 10,
  /** `physics.state` goes out at step 0 and every this many steps (250 ms), plus at finish. */
  publishEverySteps: 25,
  /** `physics.state-batch` goes out at step 0 and every this many steps (50 ms), plus at finish. */
  batchEverySteps: 5,
  /** At most this many steps per wake, so a long catch-up never blocks the event loop in one piece. */
  maxStepsPerWake: 1000,
});

/** The time of state `step`: from the index, never by repeated addition. */
export function stepTime(startedAt: number, step: number): number {
  return startedAt + ENGINE_DEFAULTS.stepMs * step;
}

/** Where a simulation's results go. */
export interface SimulationOutputs {
  /** The full state at step 0, every 25 steps and at finish. */
  state(state: PhysicsState): void;
  /** Every step's sample exactly once, in ascending batches with boundaries on step indices. */
  batch(batch: PhysicsStateBatch): void;
}

function sampleOf(
  step: number,
  result: MotionResult,
  trainerLoad: TrainerLoadSample | undefined,
): PhysicsSample {
  return {
    step,
    at: result.at,
    speed: result.speed,
    distance: result.distance,
    acceleration: result.acceleration,
    gradient: result.road.gradient,
    ...(trainerLoad ? { trainerLoad } : {}),
  };
}

/**
 * One ride's simulation, free of timers: the engine decides when to run it, this decides what to
 * compute. Step times and order depend only on the start time and the clock reading, never on
 * when the host gets to run it.
 */
export class RideSimulation {
  private current: MotionResult;
  /** The trainer load of the current state, when a trainer load is installed. */
  private currentLoad: TrainerLoadSample | undefined;
  private step = 0;
  private lastPublishedStep = -1;
  /** Samples computed since the previous batch. */
  private pending: PhysicsSample[] = [];

  constructor(
    readonly sessionId: string,
    readonly startedAt: number,
    private readonly motion: MotionCapability,
    private readonly outputs: SimulationOutputs,
    private readonly trainerLoad?: TrainerLoadCapability,
  ) {
    this.current = motion.initial(startedAt);
    this.currentLoad = trainerLoad?.load(this.current);
    this.pending.push(sampleOf(0, this.current, this.currentLoad));
    this.emit();
    this.flush();
  }

  /** When the next step is due. */
  nextDueAt(): number {
    return stepTime(this.startedAt, this.step + 1);
  }

  /** Computes due steps with `t <= until`, at most `limit`; returns whether more are due. */
  advanceUntil(until: number, limit = Number.POSITIVE_INFINITY): boolean {
    for (let done = 0; done < limit && this.nextDueAt() <= until; done += 1) {
      this.current = this.motion.advance(this.current, this.nextDueAt());
      // After the motion, from its result: the load never feeds back into the motion.
      this.currentLoad = this.trainerLoad?.load(this.current);
      this.step += 1;
      this.pending.push(sampleOf(this.step, this.current, this.currentLoad));
      if (this.step % ENGINE_DEFAULTS.publishEverySteps === 0) {
        this.emit();
      }
      if (this.step % ENGINE_DEFAULTS.batchEverySteps === 0) {
        this.flush();
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
    this.flush();
  }

  /** The step the next advance computes; while one fails, the failing step. */
  nextStep(): number {
    return this.step + 1;
  }

  private emit(): void {
    this.lastPublishedStep = this.step;
    this.outputs.state({
      ...this.current,
      sessionId: this.sessionId,
      step: this.step,
      ...(this.currentLoad ? { trainerLoad: this.currentLoad } : {}),
    });
  }

  private flush(): void {
    if (this.pending.length === 0) {
      return;
    }
    const samples = this.pending;
    this.pending = [];
    this.outputs.batch({ sessionId: this.sessionId, samples });
  }
}
