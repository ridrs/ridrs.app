// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { defineDataType, providerIdSchema } from './data-sources.ts';
import { defineEvent } from './events.ts';

/** The athlete profile of a source (ADR 0075): what ridrs needs, nothing more. */
export const athleteProfileSchema = z
  .object({
    /** Read only, from the provider. */
    name: z.string().min(1).optional(),
    /** W, indoor. */
    ftp: z.number().int().positive().optional(),
    /** kg */
    weight: z.number().positive().optional(),
    /** bpm */
    lthr: z.number().positive().optional(),
    /** bpm */
    maxHeartRate: z.number().positive().optional(),
  })
  .strict();

export type AthleteProfile = z.infer<typeof athleteProfileSchema>;

/** The athlete profile as a data type: one source, chosen; written by `athlete.profile.update`. */
export const athleteProfileType = defineDataType('athlete.profile', athleteProfileSchema, {
  update: athleteProfileSchema.omit({ name: true }),
});

/** Topic `athlete.profile`, keyed by provider. */
export const athleteProfileState = athleteProfileType.topic;

/** A partial change of the chosen provider's profile (`key`: the provider); no name. */
export const athleteProfileUpdateService = athleteProfileType.writes.update;

/** The athlete as a ride uses it: only the values that change the ride, never the name. */
export const rideAthleteSchema = z
  .object({
    /** Where the values come from. */
    provider: providerIdSchema,
    ftp: z.number().int().positive().optional(),
    weight: z.number().positive().optional(),
  })
  .strict();

export type RideAthlete = z.infer<typeof rideAthleteSchema>;

/**
 * The athlete profile the next ride will be ridden with: an input, from the owner of the data
 * source choice at host start and after every change of the chosen profile. It never changes a
 * ride under way. A provider without values (an unavailable source) hands over none.
 */
export const athleteProfileChangedEvent = defineEvent('athlete.profile-changed', rideAthleteSchema);

export type AthleteProfileChangedPayload = z.infer<typeof athleteProfileChangedEvent.schema>;

/**
 * The athlete frozen for a ride: published by the activity session when a new session starts,
 * right before it runs and beside `activity.equipment`, and kept for the whole session. Not
 * published without a profile: then the physics keeps its defaults.
 */
export const activityAthleteEvent = defineEvent(
  'activity.athlete',
  z.object({ sessionId: z.string().min(1), athlete: rideAthleteSchema }).strict(),
);

export type ActivityAthletePayload = z.infer<typeof activityAthleteEvent.schema>;
