// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  activityStateChangedEvent,
  definePlugin,
  metricCadenceCapability,
  metricHeartRateCapability,
  metricPowerCapability,
  physicsMotionCapability,
  physicsStateBatchEvent,
  physicsStateEvent,
  type TaskId,
  type TemporalSeriesReader,
  trainerErgRequestedEvent,
  trainerTargetPowerEvent,
  WORKOUT_INTENSITY,
  type WorkoutHaltChangedPayload,
  workoutFinishedEvent,
  workoutHaltChangedEvent,
  workoutIntensityChangedEvent,
  workoutNextStepRequestedEvent,
  workoutStepChangedEvent,
} from '@ridrs/contracts';
import { HALT_DEFAULTS, type HaltView, WorkoutHalt } from './halt.ts';
import { type ConditionUnit, type Progress, type StepBegan, WorkoutRun } from './player.ts';

/** ms of one physics step: the ride's time is `STEP_MS · (step - timeFromStep)`. */
const STEP_MS = 10;

/** ms between two looks at the workout: ramps follow every second of ridden time. */
const TICK_MS = 1000;

interface Ride {
  readonly sessionId: string;
  readonly run: WorkoutRun;
  /** % of the workout's power targets, as the rider set it last. */
  intensity: number;
  /**
   * Whether the rider left the workout's ERG: then the workout sets no target, through every
   * step, until the rider enters ERG again.
   */
  released: boolean;
  /** ms ridden up to `since`, or up to the pause. */
  ridden: number;
  /** When the ride ran on last; undefined while it is paused. */
  since?: number;
  task?: TaskId;
  /** m, the latest virtual distance of the ride. */
  distance: number;
  /** J of work up to `workAt` (ridden ms). */
  work: number;
  workAt: number;
  /** Whether the workout halted itself, and how it runs again (ADR 0113). */
  readonly halt: WorkoutHalt;
  /** The looks at the halt, every 250 ms of the ride's clock while the ride runs. */
  monitor?: TaskId;
  /** m the ride went while the workout was halted: a distance step does not count them. */
  haltedMeters: number;
  /** m of the ride when the workout halted; undefined while it runs. */
  haltedAtMeters?: number;
  /** The halt as published last. */
  published?: string;
}

/** A ride whose workout waits for the ride to roll. */
interface Waiting {
  readonly sessionId: string;
  readonly run: WorkoutRun;
}

/**
 * The workout player (structured-workouts.md, section 11a): rides the workout of the activity
 * state on the ridden time of `ctx.clock`, so a pause holds it, and a replay and a continued ride
 * rebuild it from the recorded inputs alone. At every whole second of ridden time it passes the
 * steps that ended and sets the ERG target of the step it is in, as a derived
 * `trainer.target-power`: the target follows from the workout, the clock, the rider's
 * "Next step" and the workout's intensity (`workout.intensity-changed`, which scales every power
 * target from then on), so a replay computes it again and compares it. A step without an ERG target leaves
 * ERG, and the trainer rides on the gradient of the route; so does the end of the workout
 * (`workout.finished`). It says where it is in `workout.step-changed`.
 *
 * The rider may leave the workout's ERG (`trainer.erg-requested` `leave`, rider input, recorded)
 * during a step with a power target: then the workout sets no target any more, and the trainer
 * rides on the gradient and the gears at a load of the rider's own, through every step, until the
 * rider enters ERG again (`enter`) and the workout takes the target back at once.
 *
 * The workout starts with the ride's time: with a motion that waits at the ride's start for its
 * world and the rider's first pedal stroke (`rolling: false`, the video's lead-in), the workout
 * holds, without a target, until a `physics.state` of the ride rolls, and then begins at the
 * step the ride's time counts from (`timeFromStep`). Without a motion it begins at once.
 */
export default definePlugin({
  start(ctx) {
    const readers: Readonly<Record<ConditionUnit, TemporalSeriesReader>> = {
      watts: ctx.temporal.reader(metricPowerCapability),
      bpm: ctx.temporal.reader(metricHeartRateCapability),
      rpm: ctx.temporal.reader(metricCadenceCapability),
    };
    /** Whether the ride has a motion, which reports when the ride rolls. */
    const hasMotion = ctx.capabilities.find(physicsMotionCapability) !== undefined;
    /** The ERG target in force, by whoever set it last. */
    let target: number | null = null;
    let ride: Ride | undefined;
    let waiting: Waiting | undefined;
    let sessionId: string | undefined;
    let workoutKey: string | undefined;
    let rollingSession: string | undefined;
    let sessionDistance = 0;
    /** The intensity of the ride that waits for its first pedal stroke; a new ride is at 100 %. */
    let intensity: number = WORKOUT_INTENSITY.default;

    ctx.events.subscribe(trainerTargetPowerEvent, ({ payload }) => {
      target = payload.watts;
    });

    ctx.events.subscribe(physicsStateBatchEvent, ({ payload }) => {
      const distance = payload.samples.at(-1)?.distance;
      if (distance !== undefined) {
        if (sessionId === payload.sessionId) {
          sessionDistance = distance;
        }
        if (ride?.sessionId === payload.sessionId) {
          ride.distance = distance;
        }
      }
    });

    /** m the workout counts: without the metres ridden while it was halted. */
    const stepDistance = (current: Ride): number =>
      (current.haltedAtMeters ?? current.distance) - current.haltedMeters;

    const riddenNow = (current: Ride): number =>
      current.ridden + (current.since === undefined ? 0 : ctx.clock.now() - current.since);

    const valueOf = (reader: TemporalSeriesReader): number | undefined => {
      const read = reader.valueAt(ctx.clock.now());
      return read.status === 'available' ? read.value : undefined;
    };

    /** Where the ride is now; the work grows by the measured power since the last look. */
    const progressOf = (current: Ride): Progress => {
      const ridden = riddenNow(current);
      const watts = valueOf(readers.watts);
      current.work += ((watts ?? 0) * (ridden - current.workAt)) / 1000;
      current.workAt = ridden;
      const values: Partial<Record<ConditionUnit, number>> = {};
      for (const unit of ['watts', 'bpm', 'rpm'] as const) {
        const value = unit === 'watts' ? watts : valueOf(readers[unit]);
        if (value !== undefined) {
          values[unit] = value;
        }
      }
      return { ridden, distance: stepDistance(current), work: current.work, values };
    };

    const setTarget = (watts: number | null): void => {
      if (watts !== target) {
        ctx.events.publish(trainerTargetPowerEvent, { watts });
      }
    };

    const stop = (current: Ride): void => {
      if (current.task !== undefined) {
        ctx.clock.cancel(current.task);
        current.task = undefined;
      }
    };

    /** The step's target at the ride's intensity, before the halt's ceiling; null without one. */
    const stepTarget = (current: Ride, progress: Progress): number | null =>
      current.released ? null : current.run.target(progress, current.intensity);

    /** The target the trainer gets while the workout runs: the step's, under the halt's ceiling. */
    const runningTarget = (current: Ride, progress: Progress): number | null => {
      const erg = stepTarget(current, progress);
      const ceiling = current.halt.peek().ceiling;
      return erg === null || ceiling === 100 ? erg : Math.round((erg * ceiling) / 100);
    };

    const publishHalt = (current: Ride, view: HaltView): void => {
      const payload: WorkoutHaltChangedPayload = {
        state: view.state,
        ...(view.secondsLeft === undefined ? {} : { secondsLeft: view.secondsLeft }),
        ...(view.waiting ? { waiting: true } : {}),
        ...(view.ceiling < 100 ? { ceiling: view.ceiling } : {}),
      };
      const key = JSON.stringify(payload);
      // Nothing to say while the workout runs as it always did.
      if (key === current.published || (current.published === undefined && key === '{"state":"running"}')) {
        return;
      }
      current.published = key;
      ctx.events.publish(workoutHaltChangedEvent, payload);
    };

    /** The workout halts: its time stands, the trainer rides the route. */
    const freeze = (current: Ride): void => {
      if (current.since !== undefined) {
        progressOf(current);
        current.ridden += ctx.clock.now() - current.since;
        current.since = undefined;
      }
      stop(current);
      current.haltedAtMeters ??= current.distance;
      setTarget(null);
    };

    /** The workout runs again where it stood. */
    const thaw = (current: Ride): void => {
      if (current.haltedAtMeters !== undefined) {
        current.haltedMeters += current.distance - current.haltedAtMeters;
        current.haltedAtMeters = undefined;
      }
      if (current.since === undefined) {
        current.since = ctx.clock.now();
        current.workAt = current.ridden;
        schedule(current);
      }
      const erg = runningTarget(current, progressOf(current));
      if (erg !== null) {
        setTarget(erg);
      }
    };

    /** The latest reported value, not one estimated past it; undefined where not available. */
    const reported = (reader: TemporalSeriesReader): number | undefined => {
      const read = reader.valueAt(ctx.clock.now());
      if (read.status !== 'available') {
        return undefined;
      }
      const last = reader.valueAt(read.sourceMeasuredAt);
      return Math.max(0, last.status === 'available' ? last.value : read.value);
    };

    /** One look at the halt, and what follows from it. */
    const look = (current: Ride): void => {
      const before = current.halt.current;
      const progress = progressOf(current);
      const view = current.halt.look(
        {
          at: ctx.clock.now(),
          watts: reported(readers.watts),
          rpm: reported(readers.rpm),
        },
        stepTarget(current, progress),
      );
      if (before === 'running' && view.state !== 'running') {
        freeze(current);
      } else if (before !== 'running' && view.state === 'running') {
        thaw(current);
      } else if (view.state === 'countdown') {
        setTarget(view.rampWatts ?? null);
      } else if (before === 'countdown' && view.state === 'halted') {
        setTarget(null);
      }
      publishHalt(current, view);
    };

    const stopMonitor = (current: Ride): void => {
      if (current.monitor !== undefined) {
        ctx.clock.cancel(current.monitor);
        current.monitor = undefined;
      }
    };

    /** Looks at the halt every 250 ms of the ride's clock, while the ride runs. */
    const monitor = (current: Ride): void => {
      stopMonitor(current);
      current.monitor = ctx.clock.scheduleAt(ctx.clock.now() + HALT_DEFAULTS.tickMs, () => {
        current.monitor = undefined;
        if (ride !== current) {
          return;
        }
        look(current);
        if (ride === current) {
          monitor(current);
        }
      });
    };

    /**
     * Publishes what a look at the workout found: the steps that began, then the target. `at` is
     * when they began; the first step began when the ride's time began.
     */
    const apply = (
      current: Ride,
      began: readonly StepBegan[],
      progress: Progress,
      at = ctx.clock.now(),
    ): void => {
      for (const step of began) {
        ctx.events.publish(workoutStepChangedEvent, { ...step, startedAt: at });
      }
      if (began.length > 0) {
        current.halt.stepBegan();
        publishHalt(current, current.halt.peek());
      }
      const run = current.run;
      if (run.finished) {
        setTarget(null);
        stop(current);
        stopMonitor(current);
        ctx.events.publish(workoutFinishedEvent, { at: ctx.clock.now() });
        ride = undefined;
        return;
      }
      // A step without an ERG target leaves ERG once, when it begins: then the rider may ride it
      // with ERG of their own. A step with one holds its target against every other source.
      if (current.released || current.halt.current !== 'running') {
        return;
      }
      const erg = runningTarget(current, progress);
      if (erg !== null || began.length > 0) {
        setTarget(erg);
      }
    };

    /** The next look, at the next whole second of ridden time. */
    const schedule = (current: Ride): void => {
      stop(current);
      const left = TICK_MS - (riddenNow(current) % TICK_MS);
      current.task = ctx.clock.scheduleAt(ctx.clock.now() + left, () => {
        current.task = undefined;
        const progress = progressOf(current);
        apply(current, current.run.advance(progress), progress);
        if (ride === current) {
          schedule(current);
        }
      });
    };

    /**
     * Begins the workout at `from`, when the ride's time began (or when a workout was loaded
     * mid-ride): `paused` holds the workout's clock until the ride resumes.
     */
    const begin = (
      currentSessionId: string,
      run: WorkoutRun,
      from: number,
      paused = false,
    ): void => {
      waiting = undefined;
      const current: Ride = {
        sessionId: currentSessionId,
        run,
        intensity,
        released: false,
        halt: new WorkoutHalt(),
        haltedMeters: 0,
        ridden: 0,
        ...(paused ? {} : { since: from }),
        distance: sessionDistance,
        work: 0,
        workAt: paused ? 0 : ctx.clock.now() - from,
      };
      ride = current;
      const progress: Progress = { ...progressOf(current), ridden: 0, distance: sessionDistance, work: 0 };
      apply(current, run.begin(progress), progress, from);
      if (ride === current && !paused) {
        schedule(current);
        monitor(current);
      }
    };

    ctx.events.subscribe(physicsStateEvent, ({ payload }) => {
      if (payload.rolling !== false) {
        rollingSession = payload.sessionId;
      }
      const wait = waiting;
      if (!wait || payload.sessionId !== wait.sessionId || payload.rolling === false) {
        return;
      }
      const from = payload.at - (payload.step - (payload.timeFromStep ?? 0)) * STEP_MS;
      begin(wait.sessionId, wait.run, Math.min(ctx.clock.now(), from));
    });

    ctx.events.subscribe(activityStateChangedEvent, ({ payload }) => {
      if (payload.state === 'idle') {
        if (ride) {
          stop(ride);
          stopMonitor(ride);
          ride = undefined;
        }
        waiting = undefined;
        sessionId = undefined;
        workoutKey = undefined;
        rollingSession = undefined;
        sessionDistance = 0;
        intensity = WORKOUT_INTENSITY.default;
        return;
      }
      if (payload.state === 'finished') {
        if (waiting?.sessionId === payload.sessionId) {
          waiting = undefined;
        }
        if (ride?.sessionId === payload.sessionId) {
          stop(ride);
          stopMonitor(ride);
          ride = undefined;
        }
        if (sessionId === payload.sessionId) {
          sessionId = undefined;
          workoutKey = undefined;
          rollingSession = undefined;
          sessionDistance = 0;
        }
        return;
      }
      const newSession = payload.sessionId !== sessionId;
      const nextKey = payload.workout ? JSON.stringify(payload.workout.workout) : undefined;
      if (newSession || nextKey !== workoutKey) {
        if (ride) {
          stop(ride);
          stopMonitor(ride);
          ride = undefined;
        }
        waiting = undefined;
        if (newSession) {
          sessionId = payload.sessionId;
          sessionDistance = 0;
        }
        workoutKey = nextKey;
        intensity = WORKOUT_INTENSITY.default;
        if (!payload.workout) {
          if (!newSession) {
            setTarget(null);
          }
          return;
        }
        const run = new WorkoutRun(payload.workout.workout);
        if (hasMotion && rollingSession !== payload.sessionId) {
          waiting = { sessionId: payload.sessionId, run };
        } else {
          begin(payload.sessionId, run, ctx.clock.now(), payload.state === 'paused');
        }
        return;
      }
      const current = ride;
      if (!current || payload.sessionId !== current.sessionId) {
        return;
      }
      if (payload.state === 'paused') {
        stopMonitor(current);
        if (current.since !== undefined) {
          progressOf(current);
          current.ridden += ctx.clock.now() - current.since;
          current.since = undefined;
          stop(current);
        }
      } else if (payload.state === 'running' && current.monitor === undefined) {
        // Back from the rider's pause, the rider stands: with power and cadence to tell when they
        // pedal again, the workout waits for that, as after a stop (ADR 0113).
        const known =
          valueOf(readers.watts) !== undefined && valueOf(readers.rpm) !== undefined;
        if (known && stepTarget(current, progressOf(current)) !== null) {
          current.halt.resumed(ctx.clock.now());
          freeze(current);
          publishHalt(current, current.halt.peek());
        } else if (current.halt.current === 'running' && current.since === undefined) {
          current.since = ctx.clock.now();
          schedule(current);
        }
        monitor(current);
      }
    });

    ctx.events.subscribe(workoutIntensityChangedEvent, ({ payload }) => {
      intensity = payload.percent;
      const current = ride;
      if (!current || current.intensity === payload.percent) {
        return;
      }
      current.intensity = payload.percent;
      if (current.released || current.halt.current !== 'running') {
        return;
      }
      // A step with a power target takes the new intensity at once; one without stays as it is.
      const erg = runningTarget(current, progressOf(current));
      if (erg !== null) {
        setTarget(erg);
      }
    });

    // Leaving ERG during a step with a power target releases the workout's hold on the target;
    // entering ERG again takes it back. In a step without one, ERG is the rider's own
    // (`control-erg`), and only entering it ends a release.
    ctx.events.subscribe(trainerErgRequestedEvent, ({ payload }) => {
      const current = ride;
      if (!current) {
        return;
      }
      if (payload.change === 'leave' && !current.released) {
        if (current.run.target(progressOf(current), current.intensity) !== null) {
          current.released = true;
          setTarget(null);
          // A halted workout runs on at the rider's own load.
          if (current.halt.current !== 'running') {
            current.halt.reset();
            thaw(current);
            publishHalt(current, current.halt.peek());
          }
        }
      } else if (payload.change === 'enter' && current.released) {
        current.released = false;
        const erg = runningTarget(current, progressOf(current));
        if (erg !== null) {
          setTarget(erg);
        }
      }
    });

    ctx.events.subscribe(workoutNextStepRequestedEvent, () => {
      const current = ride;
      if (!current || (current.since === undefined && current.halt.current === 'running')) {
        ctx.logger.debug({}, 'workout-player: no workout runs, "Next step" changes nothing');
        return;
      }
      const progress = progressOf(current);
      apply(current, current.run.skip(progress), progress);
    });
  },
});
