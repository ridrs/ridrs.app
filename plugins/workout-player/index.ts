// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  activityStateChangedEvent,
  definePlugin,
  metricCadenceCapability,
  metricHeartRateCapability,
  metricPowerCapability,
  physicsStateBatchEvent,
  type TaskId,
  type TemporalSeriesReader,
  trainerTargetPowerEvent,
  workoutFinishedEvent,
  workoutNextStepRequestedEvent,
  workoutStepChangedEvent,
} from '@ridrs/contracts';
import { type ConditionUnit, type Progress, type StepBegan, WorkoutRun } from './player.ts';

/** ms between two looks at the workout: ramps follow every second of ridden time. */
const TICK_MS = 1000;

interface Ride {
  readonly sessionId: string;
  readonly run: WorkoutRun;
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

/**
 * The workout player (structured-workouts.md, section 11a): rides the workout of the activity
 * state on the ridden time of `ctx.clock`, so a pause holds it, and a replay and a continued ride
 * rebuild it from the recorded inputs alone. At every whole second of ridden time it passes the
 * steps that ended and sets the ERG target of the step it is in, as a derived
 * `trainer.target-power`: the target follows from the workout, the clock and the rider's
 * "Next step", so a replay computes it again and compares it. A step without an ERG target leaves
 * ERG, and the trainer rides on the gradient of the route; so does the end of the workout
 * (`workout.finished`). It says where it is in `workout.step-changed`.
 */
export default definePlugin({
  start(ctx) {
    const readers: Readonly<Record<ConditionUnit, TemporalSeriesReader>> = {
      watts: ctx.temporal.reader(metricPowerCapability),
      bpm: ctx.temporal.reader(metricHeartRateCapability),
      rpm: ctx.temporal.reader(metricCadenceCapability),
    };
    /** The ERG target in force, by whoever set it last. */
    let target: number | null = null;
    let ride: Ride | undefined;

    ctx.events.subscribe(trainerTargetPowerEvent, ({ payload }) => {
      target = payload.watts;
    });

    ctx.events.subscribe(physicsStateBatchEvent, ({ payload }) => {
      const distance = payload.samples.at(-1)?.distance;
      if (ride?.sessionId === payload.sessionId && distance !== undefined) {
        ride.distance = distance;
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

    /** Publishes what a look at the workout found: the steps that began, then the target. */
    const apply = (current: Ride, began: readonly StepBegan[], progress: Progress): void => {
      const at = ctx.clock.now();
      for (const step of began) {
        ctx.events.publish(workoutStepChangedEvent, { ...step, startedAt: at });
      }
      const run = current.run;
      if (run.finished) {
        setTarget(null);
        stop(current);
        ctx.events.publish(workoutFinishedEvent, { at });
        ride = undefined;
        return;
      }
      // A step without an ERG target leaves ERG once, when it begins: then the rider may ride it
      // with ERG of their own. A step with one holds its target against every other source.
      const erg = run.target(progress);
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

    const begin = (sessionId: string, run: WorkoutRun): void => {
      const current: Ride = {
        sessionId,
        run,
        ridden: 0,
        since: ctx.clock.now(),
        distance: 0,
        work: 0,
        workAt: 0,
      };
      ride = current;
      const progress = progressOf(current);
      apply(current, run.begin(progress), progress);
      if (ride === current) {
        schedule(current);
      }
    };

    ctx.events.subscribe(activityStateChangedEvent, ({ payload }) => {
      if (payload.state === 'running' && payload.resumedAt === undefined) {
        if (ride) {
          stop(ride);
          ride = undefined;
        }
        if (payload.workout) {
          begin(payload.sessionId, new WorkoutRun(payload.workout.workout));
        }
        return;
      }
      const current = ride;
      if (!current || payload.state === 'idle' || payload.sessionId !== current.sessionId) {
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
      } else if (payload.state === 'finished') {
        stop(current);
        ride = undefined;
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
