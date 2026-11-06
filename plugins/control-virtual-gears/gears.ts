// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ControllerButton } from '@ridrs/contracts';

/**
 * The rider's drivetrain (ADR 0055): the real gear of a Zwift Ride or a KICKR CORE with the Zwift
 * Cog (34 × 14), and 24 virtual gears in even steps from 34 × 34 (1.0) to 53 × 11 (4.82): each
 * gear about 7 % harder than the one below. Gear 12 at the start of every ride.
 */
export const GEAR_DEFAULTS = Object.freeze({
  chainring: 34,
  cog: 14,
  gearCount: 24,
  startGear: 12,
  lowestRatio: 34 / 34,
  highestRatio: 53 / 11,
});

/** The ratio of every virtual gear, gear 1 first: a geometric series, so the steps feel even. */
export function gearRatios(
  count: number = GEAR_DEFAULTS.gearCount,
  lowest: number = GEAR_DEFAULTS.lowestRatio,
  highest: number = GEAR_DEFAULTS.highestRatio,
): readonly number[] {
  return Array.from({ length: count }, (_, i) => lowest * (highest / lowest) ** (i / (count - 1)));
}

const HARDER: ReadonlySet<ControllerButton> = new Set(['shift-up-left', 'shift-up-right']);
const EASIER: ReadonlySet<ControllerButton> = new Set(['shift-down-left', 'shift-down-right']);

/**
 * How many gears the newly pressed buttons shift: +1 per shift-up press, −1 per shift-down
 * press. Buttons held before shift nothing again.
 */
export function shiftOf(
  before: readonly ControllerButton[],
  now: readonly ControllerButton[],
): number {
  let shift = 0;
  for (const button of now) {
    if (before.includes(button)) {
      continue;
    }
    if (HARDER.has(button)) {
      shift += 1;
    } else if (EASIER.has(button)) {
      shift -= 1;
    }
  }
  return shift;
}

/** The gear after shifting, within 1 and `count`. */
export function shifted(
  gear: number,
  shift: number,
  count: number = GEAR_DEFAULTS.gearCount,
): number {
  return Math.min(count, Math.max(1, gear + shift));
}

/** The shifts of the newly pressed buttons, per side, in the order they were pressed. */
export function pressesOf(
  before: readonly ControllerButton[],
  now: readonly ControllerButton[],
): readonly { readonly side: 'left' | 'right'; readonly direction: 'harder' | 'easier' }[] {
  return now
    .filter((button) => !before.includes(button) && (HARDER.has(button) || EASIER.has(button)))
    .map((button) => ({
      side: button.endsWith('-left') ? 'left' : 'right',
      direction: HARDER.has(button) ? 'harder' : 'easier',
    }));
}
