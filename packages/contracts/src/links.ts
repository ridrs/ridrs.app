// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { defineState } from './app-state.ts';

/**
 * Links that open the app at a place (ADR 0079): `ridrs://activity/<external_id>`, which the
 * relay's page `https://ridrs.app/activities/<external_id>` bounces to. The provider of deep links
 * checks the shape of a link and that the ride exists before it says so here; anything else is
 * ignored without a sound.
 */
export const appLinkSchema = z
  .object({
    /** The session id of a ride on this device (the `external_id` it was uploaded with). */
    sessionId: z.string().min(1),
    /** When the link arrived, epoch ms: a link opened again is news again. */
    at: z.number().nonnegative(),
  })
  .strict();

export type AppLink = z.infer<typeof appLinkSchema>;

/** The latest link by its kind (`activity`). */
export const appLinkState = defineState('app.link', appLinkSchema);

/**
 * The form of a session id the relay can carry (ADR 0079): its `external_id` is
 * `^[A-Za-z0-9._-]{1,128}$`, and the ids of the host hold colons. Every other character becomes
 * `_`. It is the `external_id` of an upload, the name of a ride in a link, and what the rides of
 * this device are matched by.
 */
export const linkIdOf = (sessionId: string): string =>
  sessionId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
