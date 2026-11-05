// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { defineCapability } from './capabilities.ts';
import { defineEvent } from './events.ts';

/**
 * The rider's virtual drivetrain, independent of any trainer protocol. The capability is also a
 * temporal series (`hold`, never stale, ADR 0055): its value is the ratio of the virtual gear
 * (chainring teeth over cog teeth) from the moment the rider shifted.
 */
export interface VirtualGearCapability {
  /** The ratio of the real gear the rider pedals on the trainer, e.g. 34/14. */
  readonly realRatio: number;
  /** The ratio of every virtual gear, gear 1 first, ascending. */
  readonly ratios: readonly number[];
}

export const drivetrainVirtualGearCapability = defineCapability<
  VirtualGearCapability,
  'single',
  'drivetrain.virtual-gear'
>('drivetrain.virtual-gear', { cardinality: 'single' });

/** The virtual gear changed, in the turn of the shift: for what the rider sees, not for physics. */
export const drivetrainGearChangedEvent = defineEvent(
  'drivetrain.gear-changed',
  z.object({
    /** 1 … count. */
    index: z.number().int().positive(),
    ratio: z.number().positive(),
    count: z.number().int().positive(),
  }),
);

export type DrivetrainGearChangedPayload = z.infer<typeof drivetrainGearChangedEvent.schema>;

/**
 * The rider asks for a change of the ERG target in the activity screen: `enter` starts ERG at the
 * default target, `up` and `down` change it by a step, `leave` ends ERG. The ERG driver turns it
 * into `trainer.target-power`.
 */
export const trainerErgRequestedEvent = defineEvent(
  'trainer.erg-requested',
  z.object({ change: z.enum(['enter', 'up', 'down', 'leave']) }),
);

export type TrainerErgRequestedPayload = z.infer<typeof trainerErgRequestedEvent.schema>;

/** The rider's target power, an input: watts for ERG, `null` to leave it. */
export const trainerTargetPowerEvent = defineEvent(
  'trainer.target-power',
  z.object({ watts: z.number().int().nonnegative().nullable() }),
);

export type TrainerTargetPowerPayload = z.infer<typeof trainerTargetPowerEvent.schema>;

export const trainerCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('request-control') }),
  z.object({ kind: z.literal('start') }),
  z.object({ kind: z.literal('target-power'), watts: z.number().int() }),
  z.object({
    kind: z.literal('simulation'),
    /** Rise over run, as encoded (0.0001 steps). */
    gradient: z.number(),
    crr: z.number().nonnegative(),
    /** kg/m */
    cw: z.number().nonnegative(),
    /** m/s */
    windSpeed: z.number(),
  }),
]);

export type TrainerCommand = z.infer<typeof trainerCommandSchema>;

/** A command a trainer device plugin sends, published right before its bytes are written. */
export const trainerCommandEvent = defineEvent(
  'trainer.command',
  z.object({ deviceId: z.string().min(1), command: trainerCommandSchema }),
);

export type TrainerCommandPayload = z.infer<typeof trainerCommandEvent.schema>;

export const trainerModeSchema = z.enum(['none', 'simulation', 'erg']);

export type TrainerMode = z.infer<typeof trainerModeSchema>;

export const trainerControlSchema = z.enum([
  'unsupported',
  'requested',
  'granted',
  'refused',
  'lost',
]);

export type TrainerControl = z.infer<typeof trainerControlSchema>;

/** Whether ridrs controls the trainer, in which mode, and what the trainer can do. */
export const trainerControlChangedEvent = defineEvent(
  'trainer.control-changed',
  z.object({
    deviceId: z.string().min(1),
    mode: trainerModeSchema,
    control: trainerControlSchema,
    features: z.object({ simulation: z.boolean(), targetPower: z.boolean() }),
    /** The ERG target in force, in mode `erg`. */
    targetPower: z.number().int().optional(),
  }),
);

export type TrainerControlChangedPayload = z.infer<typeof trainerControlChangedEvent.schema>;
