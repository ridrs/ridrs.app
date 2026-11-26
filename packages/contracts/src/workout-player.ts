// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { defineEvent } from './events.ts';

/**
 * The workout player (structured-workouts.md, section 11a): it rides the workout of the activity
 * state and publishes where it is as derived events; the HUD reads them, rendering drives nothing.
 */

/**
 * A step of the ride's workout began: `index` is its place in the unrolled timeline (repeats
 * unrolled, 0 first), `stepId` the id of the workout's step, `startedAt` the ride's clock (epoch
 * ms of the host clock) when it began. Derived, published by the player.
 */
export const workoutStepChangedEvent = defineEvent(
  'workout.step-changed',
  z
    .object({
      stepId: z.string().min(1),
      index: z.number().int().nonnegative(),
      startedAt: z.number(),
    })
    .strict(),
);

export type WorkoutStepChangedPayload = z.infer<typeof workoutStepChangedEvent.schema>;

/** The ride's workout is over: ERG is off, the ride goes on as a free ride. Derived, by the player. */
export const workoutFinishedEvent = defineEvent(
  'workout.finished',
  z.object({ at: z.number() }).strict(),
);

export type WorkoutFinishedPayload = z.infer<typeof workoutFinishedEvent.schema>;

/**
 * The rider skips to the next step ("Next step" on the controller or the keyboard): rider input,
 * recorded, so that a replay skips at the same time (AGENTS.md rule 13).
 */
export const workoutNextStepRequestedEvent = defineEvent(
  'workout.next-step-requested',
  z.object({}).strict(),
);

/**
 * The workout halts itself while the rider cannot hold a step's power target (ADR 0113): the
 * rider stopped pedalling, or the cadence fell so low that ERG would hold them down. The ride goes
 * on, the trainer rides on the gradient of the route, and the step's time stands.
 *
 * - `running`: the workout runs, ERG holds the step's target.
 * - `halted`: the step's time stands; pedalling at 30 rpm or more starts the countdown.
 * - `countdown`: `secondsLeft` (5 … 1) until the workout runs again, while the target rises from
 *   the power the rider pedals to the step's; `waiting` while the cadence is below 55 rpm, when
 *   it does not count and the load does not change.
 *
 * Derived, by the player, from the measured power and cadence on the ride's clock, so a replay
 * computes it again. Published when one of its fields changes.
 */
export const workoutHaltChangedEvent = defineEvent(
  'workout.halt-changed',
  z
    .object({
      state: z.enum(['running', 'halted', 'countdown']),
      secondsLeft: z.number().int().min(1).max(5).optional(),
      waiting: z.boolean().optional(),
      /** % of the step's target the workout holds after a repeated halt; absent at 100 %. */
      ceiling: z.number().int().min(50).max(99).optional(),
    })
    .strict(),
);

export type WorkoutHaltChangedPayload = z.infer<typeof workoutHaltChangedEvent.schema>;

/** The workout's intensity: 100 % rides the workout as planned. */
export const WORKOUT_INTENSITY = Object.freeze({ min: 50, max: 150, default: 100, step: 1 });

/**
 * The rider changes the workout's intensity (plus and minus while a step holds the target): every
 * power target of the ride's workout is scaled by `percent` from then on. Rider input, accepted by
 * the ERG driver and recorded, so that a replay and a continued ride scale the same (AGENTS.md
 * rule 13). A new ride starts at 100 %.
 */
export const workoutIntensityChangedEvent = defineEvent(
  'workout.intensity-changed',
  z
    .object({
      percent: z.number().int().min(WORKOUT_INTENSITY.min).max(WORKOUT_INTENSITY.max),
    })
    .strict(),
);

export type WorkoutIntensityChangedPayload = z.infer<typeof workoutIntensityChangedEvent.schema>;
