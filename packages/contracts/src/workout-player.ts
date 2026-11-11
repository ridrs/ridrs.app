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
