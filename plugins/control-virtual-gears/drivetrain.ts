// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Drivetrain } from '@ridrs/contracts';

/** Chainring 1 is the smallest, sprocket 1 the largest, as Shimano numbers them. */
export interface GearPosition {
  readonly front: number;
  readonly rear: number;
}

export type Shifter = 'left' | 'right';
export type Direction = 'harder' | 'easier';

const clamp = (value: number, max: number) => Math.min(max, Math.max(1, value));

export function teethAt(
  drivetrain: Drivetrain,
  at: GearPosition,
): { readonly chainring: number; readonly sprocket: number } {
  return {
    chainring: drivetrain.chainrings[at.front - 1] ?? 1,
    sprocket: drivetrain.sprockets[at.rear - 1] ?? 1,
  };
}

/** Chainring teeth over sprocket teeth. */
export function ratioAt(drivetrain: Drivetrain, at: GearPosition): number {
  const { chainring, sprocket } = teethAt(drivetrain, at);
  return chainring / sprocket;
}

/** Every combination's ratio once, easiest first: the gears as the trainer load counts them. */
export function drivetrainRatios(drivetrain: Drivetrain): readonly number[] {
  const ratios = new Set<number>();
  drivetrain.chainrings.forEach((_, f) => {
    drivetrain.sprockets.forEach((_, r) => {
      ratios.add(ratioAt(drivetrain, { front: f + 1, rear: r + 1 }));
    });
  });
  return [...ratios].sort((a, b) => a - b);
}

/** A front shift; the synchro modes let the rear compensate it by the semi-synchro value. */
function shiftFront(drivetrain: Drivetrain, at: GearPosition, direction: Direction): GearPosition {
  const front = clamp(at.front + (direction === 'harder' ? 1 : -1), drivetrain.chainrings.length);
  if (front === at.front) {
    return at;
  }
  const { mode, semiSynchroCompensation } = drivetrain.shifting;
  if (mode === 'manual') {
    return { front, rear: at.rear };
  }
  // A larger chainring is harder: the rear goes to larger sprockets (lower numbers) to soften it.
  const compensation = direction === 'harder' ? -semiSynchroCompensation : semiSynchroCompensation;
  return { front, rear: clamp(at.rear + compensation, drivetrain.sprockets.length) };
}

/**
 * One press of a Di2 shifter (ADR 0060). Manual: the left shifter moves the front derailleur, the
 * right one the rear. Semi-synchro: a front shift moves the rear by the compensation the other
 * way. Full synchro: the right shifter alone runs through the range; harder from the small
 * chainring at the shift point's sprocket or beyond switches to the large chainring, easier from
 * the large one at its shift point or below to the small one, the rear going to the given
 * sprocket; the left shifter still shifts the front, compensated as in semi-synchro. Nothing
 * moves beyond the ends.
 */
export function shiftDrivetrain(
  drivetrain: Drivetrain,
  at: GearPosition,
  shifter: Shifter,
  direction: Direction,
): GearPosition {
  if (shifter === 'left') {
    return shiftFront(drivetrain, at, direction);
  }
  const { mode, fullSynchro } = drivetrain.shifting;
  if (mode === 'full-synchro' && drivetrain.chainrings.length === 2) {
    if (direction === 'harder' && at.front === 1 && at.rear >= fullSynchro.toLarge.fromRear) {
      return { front: 2, rear: clamp(fullSynchro.toLarge.toRear, drivetrain.sprockets.length) };
    }
    if (direction === 'easier' && at.front === 2 && at.rear <= fullSynchro.toSmall.fromRear) {
      return { front: 1, rear: clamp(fullSynchro.toSmall.toRear, drivetrain.sprockets.length) };
    }
  }
  // A smaller sprocket is harder; sprockets are numbered from the largest.
  const rear = clamp(at.rear + (direction === 'harder' ? 1 : -1), drivetrain.sprockets.length);
  return rear === at.rear ? at : { front: at.front, rear };
}
