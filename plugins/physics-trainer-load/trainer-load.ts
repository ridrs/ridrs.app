// SPDX-License-Identifier: AGPL-3.0-or-later

import { STANDARD_GRAVITY, type TrainerLoad } from '@ridrs/contracts';

/**
 * The brake force an FTMS trainer applies for simulation parameters at its own wheel speed `v`:
 * F = m · g · (G + Crr) + ½ · cw · v² in still air (the FE-C / FTMS model; small angles, so the
 * grade acts linearly). `mass` is the rider and bicycle mass the trainer simulates.
 */
export function trainerForce(load: TrainerLoad, mass: number, speed: number): number {
  return (
    mass * STANDARD_GRAVITY * (load.gradient + load.rollingResistanceCoefficient) +
    0.5 * load.windResistanceCoefficient * speed * speed
  );
}

/**
 * The load a trainer without virtual shifting must get so that the rider, pedalling its real
 * gear, feels the virtual gear (ADR 0054).
 *
 * At a cadence c the trainer's wheel turns at v_t = v / k with k = ratio_virtual / ratio_real,
 * when the virtual bike rolls at v in the virtual gear. The crank torque is the wheel force times
 * the wheel radius times the gear ratio, so equal torque at the crank needs
 * F_trainer(v_t) = k · F_virtual(v). With the trainer's model and Crr and cw unchanged, that
 * gives the effective gradient
 *
 *   G' = k · (G + Crr) − Crr + ½ · cw · v² · (k − 1/k²) / (m · g).
 *
 * For k = 1 it is G: on the real gear the trainer gets the virtual bike's own load.
 */
export function loadWithVirtualGear(
  load: TrainerLoad,
  options: { readonly gearFactor: number; readonly mass: number; readonly speed: number },
): TrainerLoad {
  const { gearFactor: k, mass, speed } = options;
  if (k === 1) {
    return load;
  }
  const crr = load.rollingResistanceCoefficient;
  const air = 0.5 * load.windResistanceCoefficient * speed * speed;
  const gradient =
    k * (load.gradient + crr) - crr + (air * (k - 1 / (k * k))) / (mass * STANDARD_GRAVITY);
  return { ...load, gradient };
}
