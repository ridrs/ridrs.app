// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type Bicycle,
  bicycleSchema,
  type SettingsDocument,
  shiftModeSchema,
} from '@ridrs/contracts';
import { z } from 'zod';
import di2 from './equipment/shimano-di2-2x12-50-34-11-34.json' with { type: 'json' };

const gear = z.number().int().positive();
const shiftPoint = z.object({ fromRearGear: gear, toRearGear: gear });

/**
 * An equipment specification file: what a drivetrain is made of and how it shifts. Only the
 * values the ride uses are read; the descriptions, evidence and sources stay in the file.
 */
export const specificationSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  drivetrain: z.object({
    chainrings: z.object({ teeth: z.array(z.number().int().positive()).min(1).max(2) }),
    cassette: z.object({ teeth: z.array(z.number().int().positive()).min(1).max(13) }),
  }),
  shifting: z.object({
    system: z.literal('di2'),
    semiSynchro: z.object({ rearCompensation: z.object({ sprockets: z.number().int().min(0).max(4) }) }),
    fullSynchro: z.object({
      shiftPoints: z.object({ toLargeChainring: shiftPoint, toSmallChainring: shiftPoint }),
    }),
  }),
});

export type Specification = z.infer<typeof specificationSchema>;

/** The drivetrains the garage offers, from the specification files next to this module. */
export const SPECIFICATIONS: readonly Specification[] = [specificationSchema.parse(di2)];

const DEFAULT_SPECIFICATION = SPECIFICATIONS[0] as Specification;

/** What the rider sets in the garage; everything else comes from the specification (ADR 0060). */
export const bicycleDocumentSchema = z
  .object({
    name: z.string().trim().min(1).max(40),
    /** kg */
    mass: z.number().min(5).max(25),
    /** The id of a specification file. */
    drivetrain: z.string().min(1),
    shiftMode: shiftModeSchema,
    /** Chainring 1 is the smallest, sprocket 1 the largest. */
    startGear: z.object({ front: gear, rear: gear }).strict(),
  })
  .strict();

export type BicycleDocument = z.infer<typeof bicycleDocumentSchema>;

export const BICYCLE_DOCUMENT: SettingsDocument<BicycleDocument> = {
  name: 'bicycle',
  version: 1,
  schema: bicycleDocumentSchema,
};

/** A road bicycle of 10 kg (the old default of `physics-bicycle`), in 34 × 17. */
export const DEFAULT_BICYCLE: BicycleDocument = {
  name: 'My bike',
  mass: 10,
  drivetrain: DEFAULT_SPECIFICATION.id,
  shiftMode: 'manual',
  startGear: { front: 1, rear: 7 },
};

export function specificationOf(id: string): Specification {
  return SPECIFICATIONS.find((spec) => spec.id === id) ?? DEFAULT_SPECIFICATION;
}

/**
 * The bicycle as a ride uses it: the document with its drivetrain's teeth and shift map. A start
 * gear outside the drivetrain is moved to its nearest end.
 */
export function resolveBicycle(document: BicycleDocument): Bicycle {
  const spec = specificationOf(document.drivetrain);
  const chainrings = spec.drivetrain.chainrings.teeth;
  const sprockets = spec.drivetrain.cassette.teeth;
  const { toLargeChainring, toSmallChainring } = spec.shifting.fullSynchro.shiftPoints;
  return bicycleSchema.parse({
    name: document.name,
    mass: document.mass,
    drivetrain: {
      id: spec.id,
      chainrings,
      sprockets,
      shifting: {
        mode: document.shiftMode,
        semiSynchroCompensation: spec.shifting.semiSynchro.rearCompensation.sprockets,
        fullSynchro: {
          toLarge: { fromRear: toLargeChainring.fromRearGear, toRear: toLargeChainring.toRearGear },
          toSmall: { fromRear: toSmallChainring.fromRearGear, toRear: toSmallChainring.toRearGear },
        },
      },
      startGear: {
        front: Math.min(document.startGear.front, chainrings.length),
        rear: Math.min(document.startGear.rear, sprockets.length),
      },
    },
  });
}

/** The gear of a drivetrain with these teeth, for steps and the garage's start gear. */
export function gearWithTeeth(
  spec: Specification,
  chainring: number,
  sprocket: number,
): { readonly front: number; readonly rear: number } | undefined {
  const front = spec.drivetrain.chainrings.teeth.indexOf(chainring) + 1;
  const rear = spec.drivetrain.cassette.teeth.indexOf(sprocket) + 1;
  return front > 0 && rear > 0 ? { front, rear } : undefined;
}
