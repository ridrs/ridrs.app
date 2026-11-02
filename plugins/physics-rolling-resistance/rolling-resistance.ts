// SPDX-License-Identifier: AGPL-3.0-or-later

import { STANDARD_GRAVITY } from '@ridrs/contracts';

/**
 * F_roll = Crr · m · g while moving, 0 at standstill: a bicycle standing still has no rolling
 * loss, so it stays at rest without power and starts as soon as there is drive force.
 */
export function rollingResistanceForce(crr: number, mass: number, speed: number): number {
  return speed > 0 ? crr * mass * STANDARD_GRAVITY : 0;
}
