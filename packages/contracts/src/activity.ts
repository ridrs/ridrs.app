// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { providerIdSchema } from './data-sources.ts';
import { defineEvent } from './events.ts';
import { workoutSchema } from './workout.ts';

/**
 * Where a ride takes place: the landscape that shows it and, within that world, the route. A ride
 * without one is a free ride on whatever landscape runs.
 */
export const rideWorldSchema = z
  .object({
    /** The landscape contribution that shows the ride, `<pluginId>/<contributionId>`. */
    landscape: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
    /** The route within that world, as the landscape names it. */
    route: z.string().min(1).optional(),
  })
  .strict();

export type RideWorld = z.infer<typeof rideWorldSchema>;

/**
 * The workout of a ride (structured-workouts.md, sections 11 and 11a): the whole workout, not an
 * id, with its % FTP and zone targets already resolved to watts (and heart rate targets to bpm)
 * with the athlete profile at the start, so that a replay needs no catalogue and gives the same
 * targets. `planned` and `library` say where it came from, so that the calendar can match the
 * ride with its planned entry.
 */
export const rideWorkoutSchema = z
  .object({
    workout: workoutSchema,
    /** The planned entry of a calendar the ride rides. */
    planned: z
      .object({ provider: providerIdSchema, id: z.string().min(1) })
      .strict()
      .optional(),
    /** The library workout it is. */
    library: z
      .object({ from: providerIdSchema, workoutId: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict();

export type RideWorkout = z.infer<typeof rideWorkoutSchema>;

/**
 * Ride lifecycle (ADR 0056). Times are epoch ms from the injected host clock. A paused ride stands
 * still while time goes on: by the rider, or because the app stopped (`interrupted`).
 */
export const activityStateSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('idle') }).strict(),
  z
    .object({
      state: z.literal('running'),
      sessionId: z.string().min(1),
      startedAt: z.number(),
      /** After a pause: when the ride went on. */
      resumedAt: z.number().optional(),
      world: rideWorldSchema.optional(),
      workout: rideWorkoutSchema.optional(),
    })
    .strict(),
  z
    .object({
      state: z.literal('paused'),
      sessionId: z.string().min(1),
      startedAt: z.number(),
      pausedAt: z.number(),
      reason: z.enum(['rider', 'interrupted']),
      world: rideWorldSchema.optional(),
      workout: rideWorkoutSchema.optional(),
    })
    .strict(),
  z
    .object({
      state: z.literal('finished'),
      sessionId: z.string().min(1),
      startedAt: z.number(),
      endedAt: z.number(),
      world: rideWorldSchema.optional(),
      workout: rideWorkoutSchema.optional(),
    })
    .strict(),
]);

export type ActivityState = z.infer<typeof activityStateSchema>;

/** Without a world: a free ride. Without a workout: ridden without one. */
export const activityStartRequestedEvent = defineEvent(
  'activity.start-requested',
  z.object({ world: rideWorldSchema.optional(), workout: rideWorkoutSchema.optional() }).strict(),
);

export const activityFinishRequestedEvent = defineEvent(
  'activity.finish-requested',
  z.object({}).strict(),
);

export const activityPauseRequestedEvent = defineEvent(
  'activity.pause-requested',
  z.object({}).strict(),
);

export const activityResumeRequestedEvent = defineEvent(
  'activity.resume-requested',
  z.object({}).strict(),
);

/** The input a recovery injects where the journal ends: the ride stood still from there (ADR 0057). */
export const activityInterruptedEvent = defineEvent('activity.interrupted', z.object({}).strict());

export const activityStateChangedEvent = defineEvent('activity.state-changed', activityStateSchema);
