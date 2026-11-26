// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * When the workout halts itself and how it runs again (ADR 0113, plans/erg-wiederaufnahme.md,
 * section 0). Pure: it knows no clock, no bus and no trainer, only the readings it is given at
 * each look (every `tickMs` of the ride's clock) and the step's target.
 *
 * In ERG the trainer holds the power, so the torque at the crank grows as the cadence falls: who
 * stops pedalling at 350 W, or sinks below about 55 rpm, cannot get back in. Then the workout
 * halts: the step's time stands and the trainer rides on the gradient of the route. Pedalling at
 * 30 rpm or more for 2 s starts a countdown of 5 s, which counts only at 55 rpm or more, while the
 * target rises from the power pedalled to the step's; after its first 2 s it ends below 30 rpm.
 *
 * Every decision waits longer than the chain measurement → trainer → rider takes (1 Hz reports,
 * about 1–2 s to the trainer), and the bands do not overlap (start 30, count 55), so the load never
 * follows the cadence back and forth.
 */

export const HALT_DEFAULTS = Object.freeze({
  /** ms between two looks. */
  tickMs: 250,
  /** W: below this the rider does not pedal; for `stopMs`, i.e. two 1-Hz reports in a row. */
  stopWatts: 25,
  stopMs: 1000,
  /** Spiral: below `spiralRpm` for `spiralMs`, and the power below `deficit` of the target or the cadence falling. */
  spiralRpm: 45,
  spiralMs: 3000,
  deficit: 0.85,
  /** rpm per s over the last `slopeMs`. */
  fallingRpmPerSecond: -3,
  slopeMs: 3000,
  /** A trainer reports the last cadence for 2–3 s after the last pedal stroke: not trusted then. */
  staleMs: 3000,
  /** The countdown starts at `startRpm` for `startMs`. */
  startRpm: 30,
  startMs: 2000,
  countdownMs: 5000,
  /** It counts only at `countRpm` or more. */
  countRpm: 55,
  /** After its first `graceMs` it ends below `abortRpm`. */
  graceMs: 2000,
  abortRpm: 30,
  /** A spiral within `ceilingWindowMs` after a countdown lowers the step's target by `ceilingStep` %. */
  ceilingWindowMs: 60_000,
  ceilingStep: 5,
  ceilingMin: 80,
});

export type HaltState = 'running' | 'halted' | 'countdown';

/** The latest measured values at a look; undefined where the series is not available. */
export interface Reading {
  readonly at: number;
  readonly watts?: number;
  readonly rpm?: number;
}

/** What the workout does after a look. */
export interface HaltView {
  readonly state: HaltState;
  /** 5 … 1 during the countdown. */
  readonly secondsLeft?: number;
  /** The countdown waits for the cadence. */
  readonly waiting?: boolean;
  /** % of the step's target, below 100 after a repeated halt. */
  readonly ceiling: number;
  /**
   * The target the trainer gets during the countdown: undefined while it has not counted yet (the
   * trainer still rides the route), else the ramp's watts.
   */
  readonly rampWatts?: number;
}

export class WorkoutHalt {
  private state: HaltState = 'running';
  private since = new Map<string, number>();
  private cadences: Array<{ at: number; rpm: number }> = [];
  private haltedAt = 0;
  private countdownAt = 0;
  private counted = 0;
  private from = 0;
  private resumedAt: number | undefined;
  private ceiling = 100;

  get current(): HaltState {
    return this.state;
  }

  /**
   * One look. `target` is the step's target in watts at 100 % of the ceiling (the workout's
   * intensity included), or null where the workout holds none: then the workout runs.
   */
  look(reading: Reading, target: number | null): HaltView {
    const { at, watts, rpm } = reading;
    if (rpm !== undefined) {
      this.cadences.push({ at, rpm });
      this.cadences = this.cadences.filter((c) => at - c.at <= HALT_DEFAULTS.slopeMs);
    }
    if (target === null) {
      this.reset();
      return this.view();
    }
    const goal = (target * this.ceiling) / 100;
    switch (this.state) {
      case 'running': {
        // Without both power and cadence the workout cannot tell, and would not know when to go on.
        if (watts === undefined || rpm === undefined) {
          this.clear();
          break;
        }
        const stopped = this.dwell('stop', watts < HALT_DEFAULTS.stopWatts, at, HALT_DEFAULTS.stopMs);
        const low = this.dwell('low', rpm < HALT_DEFAULTS.spiralRpm, at, HALT_DEFAULTS.spiralMs);
        const spiral =
          low && (watts < HALT_DEFAULTS.deficit * goal || this.slope() <= HALT_DEFAULTS.fallingRpmPerSecond);
        if (stopped || spiral) {
          if (
            spiral &&
            this.resumedAt !== undefined &&
            at - this.resumedAt <= HALT_DEFAULTS.ceilingWindowMs
          ) {
            this.ceiling = Math.max(HALT_DEFAULTS.ceilingMin, this.ceiling - HALT_DEFAULTS.ceilingStep);
          }
          this.halt(at);
        }
        break;
      }
      case 'halted': {
        const fresh = at - this.haltedAt >= HALT_DEFAULTS.staleMs;
        if (
          this.dwell('start', fresh && rpm !== undefined && rpm >= HALT_DEFAULTS.startRpm, at, HALT_DEFAULTS.startMs)
        ) {
          this.state = 'countdown';
          this.countdownAt = at;
          this.counted = 0;
          this.from = Math.max(0, watts ?? 0);
          this.clear();
        }
        break;
      }
      case 'countdown': {
        const pedalling = rpm !== undefined && rpm >= HALT_DEFAULTS.abortRpm;
        // Before the countdown raised the load, slow pedalling is little power: only the cadence
        // ends it; once it did, no power ends it as well.
        const stopped = this.dwell(
          'stop',
          this.counted > 0 && (watts ?? 0) < HALT_DEFAULTS.stopWatts,
          at,
          HALT_DEFAULTS.stopMs,
        );
        if (at - this.countdownAt >= HALT_DEFAULTS.graceMs && (!pedalling || stopped)) {
          this.halt(at);
          break;
        }
        if (rpm !== undefined && rpm >= HALT_DEFAULTS.countRpm) {
          this.counted += HALT_DEFAULTS.tickMs;
        }
        if (this.counted >= HALT_DEFAULTS.countdownMs) {
          this.state = 'running';
          this.resumedAt = at;
          this.clear();
        }
        break;
      }
    }
    return this.view(goal);
  }

  /** The halt as it is, without a new look. */
  peek(): HaltView {
    return this.view();
  }

  /** The ride resumes after a pause of the rider's: the workout waits for the first pedal strokes. */
  resumed(at: number): void {
    if (this.state !== 'halted') {
      this.halt(at);
    }
  }

  /** A new step began: the ceiling of the step before is gone. */
  stepBegan(): void {
    this.ceiling = 100;
    this.resumedAt = undefined;
  }

  /** The workout holds no target any more (released, free ride, over): it runs. */
  reset(): void {
    this.state = 'running';
    this.clear();
  }

  private halt(at: number): void {
    this.state = 'halted';
    this.haltedAt = at;
    this.clear();
  }

  private view(goal = 0): HaltView {
    if (this.state !== 'countdown') {
      return { state: this.state, ceiling: this.ceiling };
    }
    const left = Math.ceil((HALT_DEFAULTS.countdownMs - this.counted) / 1000);
    const share = this.counted / HALT_DEFAULTS.countdownMs;
    const latest = this.cadences.at(-1)?.rpm;
    return {
      state: 'countdown',
      secondsLeft: Math.max(1, left),
      waiting: latest === undefined || latest < HALT_DEFAULTS.countRpm,
      ceiling: this.ceiling,
      ...(this.counted > 0 ? { rampWatts: Math.round(this.from + (goal - this.from) * share) } : {}),
    };
  }

  private dwell(key: string, holds: boolean, at: number, ms: number): boolean {
    if (!holds) {
      this.since.delete(key);
      return false;
    }
    const since = this.since.get(key) ?? at;
    this.since.set(key, since);
    return at - since >= ms;
  }

  private clear(): void {
    this.since.clear();
  }

  /** rpm per s over the cadences of the last `slopeMs`. */
  private slope(): number {
    const first = this.cadences[0];
    const last = this.cadences.at(-1);
    if (!first || !last || last.at - first.at < HALT_DEFAULTS.slopeMs / 2) {
      return 0;
    }
    return ((last.rpm - first.rpm) * 1000) / (last.at - first.at);
  }
}
