// SPDX-License-Identifier: AGPL-3.0-or-later

import { STANDARD_GRAVITY } from '@ridrs/contracts';

/**
 * F_gravity = m · g · sin θ with θ = atan(gradient): positive uphill (it opposes the rider),
 * negative downhill (it pushes), 0 on the flat. It acts at every speed, standstill included.
 */
export function gravityResistanceForce(mass: number, gradient: number): number {
  return mass * STANDARD_GRAVITY * Math.sin(Math.atan(gradient));
}
