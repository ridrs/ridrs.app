// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { defineEvent } from './events.ts';

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
    })
    .strict(),
  z
    .object({
      state: z.literal('paused'),
      sessionId: z.string().min(1),
      startedAt: z.number(),
      pausedAt: z.number(),
      reason: z.enum(['rider', 'interrupted']),
    })
    .strict(),
  z
    .object({
      state: z.literal('finished'),
      sessionId: z.string().min(1),
      startedAt: z.number(),
      endedAt: z.number(),
    })
    .strict(),
]);

export type ActivityState = z.infer<typeof activityStateSchema>;

export const activityStartRequestedEvent = defineEvent(
  'activity.start-requested',
  z.object({}).strict(),
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
