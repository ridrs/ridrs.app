// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { defineEvent } from './events.ts';

/** Ride lifecycle. Times are epoch ms from the injected host clock. */
export const activityStateSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('idle') }).strict(),
  z
    .object({ state: z.literal('running'), sessionId: z.string().min(1), startedAt: z.number() })
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

export const activityStateChangedEvent = defineEvent('activity.state-changed', activityStateSchema);
