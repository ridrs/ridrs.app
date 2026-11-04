// SPDX-License-Identifier: AGPL-3.0-or-later

import { STANDARD_GRAVITY, type TerrainSurface } from '@ridrs/contracts';

/**
 * F_roll = Crr · m · g · cos θ with θ = atan(gradient) while moving, 0 at standstill: a bicycle
 * standing still has no rolling loss, so it stays at rest without power and starts as soon as
 * there is drive force. On a gradient only the normal force m · g · cos θ presses on the tyres.
 */
export function rollingResistanceForce(
  crr: number,
  mass: number,
  speed: number,
  gradient: number,
): number {
  return speed > 0 ? crr * mass * STANDARD_GRAVITY * Math.cos(Math.atan(gradient)) : 0;
}

export const ROLLING_DEFAULTS = Object.freeze({
  /**
   * The bicycle's coefficient is the tyre on asphalt; the surface only scales it. Gravel doubles
   * it: 0.004 → 0.008 (ADR 0044).
   */
  surfaceFactors: Object.freeze({ asphalt: 1, gravel: 2 } satisfies Record<TerrainSurface, number>),
});

/** The rolling resistance coefficient of the bicycle's tyres on `surface`. */
export function surfaceCoefficient(crr: number, surface: TerrainSurface): number {
  return crr * ROLLING_DEFAULTS.surfaceFactors[surface];
}
