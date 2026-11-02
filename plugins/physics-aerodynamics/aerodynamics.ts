// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * F_aero = ½ · ρ · CdA · v_rel · |v_rel|. The sign follows the relative airflow, so the formula
 * already holds for wind; in still air v_rel is the speed.
 */
export function aerodynamicDragForce(
  airDensity: number,
  cdA: number,
  relativeAirSpeed: number,
): number {
  return 0.5 * airDensity * cdA * relativeAirSpeed * Math.abs(relativeAirSpeed);
}
