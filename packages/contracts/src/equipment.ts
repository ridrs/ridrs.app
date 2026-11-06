// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { defineEvent } from './events.ts';

/** How the Di2 shifts: each shifter its own derailleur, or the front helped by the rear (ADR 0060). */
export const shiftModeSchema = z.enum(['manual', 'semi-synchro', 'full-synchro']);

export type ShiftMode = z.infer<typeof shiftModeSchema>;

const teeth = z.number().int().min(9).max(60);
const gear = z.number().int().positive();

/** A switch of the chainring in full synchro: from a rear gear, to a rear gear (gear 1 = largest). */
const shiftPointSchema = z.object({ fromRear: gear, toRear: gear }).strict();

/**
 * The drivetrain of a bicycle as a ride uses it, resolved from its specification: the teeth and
 * the shift map themselves, so a later change of the specification never changes a recorded ride.
 * Gears are numbered as Shimano numbers them: chainring 1 is the smallest, sprocket 1 the largest.
 */
export const drivetrainSchema = z
  .object({
    /** The specification it was resolved from. */
    id: z.string().min(1),
    chainrings: z.array(teeth).min(1).max(2),
    sprockets: z.array(teeth).min(1).max(13),
    shifting: z
      .object({
        mode: shiftModeSchema,
        /** Sprockets the rear shifts against a front shift in semi-synchro. */
        semiSynchroCompensation: z.number().int().min(0).max(4),
        /** Where full synchro switches the chainring: shifting harder on 1, easier on 2. */
        fullSynchro: z.object({ toLarge: shiftPointSchema, toSmall: shiftPointSchema }).strict(),
      })
      .strict(),
    startGear: z.object({ front: gear, rear: gear }).strict(),
  })
  .strict()
  .refine(
    (d) => d.startGear.front <= d.chainrings.length && d.startGear.rear <= d.sprockets.length,
    { message: 'The start gear must be one of the drivetrain', path: ['startGear'] },
  );

export type Drivetrain = z.infer<typeof drivetrainSchema>;

/** The bicycle a ride is ridden with (ADR 0060). */
export const bicycleSchema = z
  .object({
    name: z.string().min(1).max(40),
    /** kg */
    mass: z.number().min(5).max(25),
    drivetrain: drivetrainSchema,
  })
  .strict();

export type Bicycle = z.infer<typeof bicycleSchema>;

/**
 * The bicycle the next ride will be ridden with: an input, from the garage at host start and after
 * every change. It never changes a ride under way.
 */
export const equipmentBicycleChangedEvent = defineEvent('equipment.bicycle-changed', bicycleSchema);

export type EquipmentBicycleChangedPayload = z.infer<typeof equipmentBicycleChangedEvent.schema>;

/**
 * The bicycle frozen for a ride: published by the activity session when a new session starts,
 * right before it runs, and kept for the whole session (pause, resume and continuing included).
 * Not published without a bicycle: then the physics keeps its defaults.
 */
export const activityEquipmentEvent = defineEvent(
  'activity.equipment',
  z.object({ sessionId: z.string().min(1), bicycle: bicycleSchema }).strict(),
);

export type ActivityEquipmentPayload = z.infer<typeof activityEquipmentEvent.schema>;
