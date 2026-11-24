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
  trainerTargetPowerEvent,
  WORKOUT_INTENSITY,
  workoutFinishedEvent,
  workoutIntensityChangedEvent,
  workoutNextStepRequestedEvent,
  workoutStepChangedEvent,
} from '@ridrs/contracts';
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
      return { ridden, distance: current.distance, work: current.work, values };
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
      const run = current.run;
      if (run.finished) {
        setTarget(null);
        stop(current);
        ctx.events.publish(workoutFinishedEvent, { at: ctx.clock.now() });
        ride = undefined;
        return;
      }
      // A step without an ERG target leaves ERG once, when it begins: then the rider may ride it
      // with ERG of their own. A step with one holds its target against every other source.
      const erg = run.target(progress, current.intensity);
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
      if (payload.state === 'paused' && current.since !== undefined) {
        progressOf(current);
        current.ridden += ctx.clock.now() - current.since;
        current.since = undefined;
        stop(current);
      } else if (payload.state === 'running' && current.since === undefined) {
        current.since = ctx.clock.now();
        schedule(current);
      }
    });

    ctx.events.subscribe(workoutIntensityChangedEvent, ({ payload }) => {
      intensity = payload.percent;
      const current = ride;
      if (!current || current.intensity === payload.percent) {
        return;
      }
      current.intensity = payload.percent;
      // A step with a power target takes the new intensity at once; one without stays as it is.
      const erg = current.run.target(progressOf(current), current.intensity);
      if (erg !== null) {
        setTarget(erg);
      }
    });

    ctx.events.subscribe(workoutNextStepRequestedEvent, () => {
      const current = ride;
      if (!current || current.since === undefined) {
        ctx.logger.debug({}, 'workout-player: no workout runs, "Next step" changes nothing');
        return;
      }
      const progress = progressOf(current);
      apply(current, current.run.skip(progress), progress);
    });
  },
});
