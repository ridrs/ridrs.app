// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import type { ActivityState } from './activity.ts';
import { defineState } from './app-state.ts';
import { draggedRouteSchema, draggedWorkoutSchema } from './drag.ts';
import { defineService } from './services.ts';

/**
 * The ride the rider prepared in the menu (ADR 0096): a workout and a route, each with the name
 * shown for it when it is gone. App state, kept across a restart; `{}` is no next ride.
 */
export const nextRideSchema = z
  .object({ workout: draggedWorkoutSchema.optional(), route: draggedRouteSchema.optional() })
  .strict();

export type NextRide = z.infer<typeof nextRideSchema>;

/** The key of `ride.next`: there is one next ride. */
export const NEXT_RIDE_KEY = 'next';

/** The next ride, by its only key `next`; owner `ui-next-ride`. */
export const nextRideState = defineState('ride.next', nextRideSchema);

/** Replaces the next ride (key `next`); `{}` clears it. Answered once it is kept. */
export const nextRideSetService = defineService('ride.next-set', {
  request: z.object({ key: z.string().min(1), ride: nextRideSchema }).strict(),
  response: z.object({}).strict(),
  keyedBy: nextRideState,
});

/**
 * Whether a finished ride rode the next ride: every part the next ride holds was ridden (its
 * workout, from the library or as the planned entry, and its route), and it holds at least one.
 */
export function rodeNextRide(next: NextRide, finished: ActivityState): boolean {
  if (finished.state !== 'finished') return false;
  if (!next.workout && !next.route) return false;
  if (next.workout) {
    const ridden = finished.workout;
    const same =
      next.workout.kind === 'library'
        ? ridden?.library?.from === next.workout.from &&
          ridden.library.workoutId === next.workout.workoutId
        : ridden?.planned?.provider === next.workout.from && ridden.planned.id === next.workout.id;
    if (!same) return false;
  }
  if (next.route) {
    const world = finished.world;
    if (
      world?.landscape !== next.route.world.landscape ||
      world?.route !== next.route.world.route
    ) {
      return false;
    }
  }
  return true;
}
