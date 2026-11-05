// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TrainerLoad } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import { loadWithVirtualGear, trainerForce } from './trainer-load.ts';

const climb: TrainerLoad = {
  gradient: 0.05,
  rollingResistanceCoefficient: 0.004,
  windResistanceCoefficient: 0.392,
  windSpeed: 0,
};
const MASS = 85;
const REAL = 34 / 14;

/** Crank torque per wheel radius: wheel force times gear ratio. */
const crankTorque = (force: number, ratio: number) => force * ratio;

describe('the load with the virtual gear (ADR 0054)', () => {
  it('is the plain load on the real gear', () => {
    expect(loadWithVirtualGear(climb, { gearFactor: 1, mass: MASS, speed: 5 })).toEqual(climb);
  });

  it.each([
    ['gear 1 (34 × 34)', 1.0],
    ['gear 12', 2.1213],
    ['gear 24 (53 × 11)', 53 / 11],
  ])('at the same cadence the rider feels the virtual gear: %s', (_, ratio) => {
    const virtualSpeed = 6;
    const k = ratio / REAL;
    const withGear = loadWithVirtualGear(climb, { gearFactor: k, mass: MASS, speed: virtualSpeed });
    // The trainer's wheel turns at the speed of the real gear for the same cadence.
    const trainerSpeed = virtualSpeed / k;
    const onTrainer = crankTorque(trainerForce(withGear, MASS, trainerSpeed), REAL);
    const onVirtualBike = crankTorque(trainerForce(climb, MASS, virtualSpeed), ratio);
    expect(onTrainer).toBeCloseTo(onVirtualBike, 9);
    // Crr and cw stay: only the gradient carries the gear.
    expect(withGear.rollingResistanceCoefficient).toBe(climb.rollingResistanceCoefficient);
    expect(withGear.windResistanceCoefficient).toBe(climb.windResistanceCoefficient);
  });

  it('turns a harder gear into a steeper effective gradient, with numbers', () => {
    // Gear 16 (2.6815) on a 5 % climb at 4 m/s, 85 kg: k = 1.1041.
    const k = 2.6815 / REAL;
    const load = loadWithVirtualGear(climb, { gearFactor: k, mass: MASS, speed: 4 });
    // k (G + Crr) − Crr + ½ cw v² (k − 1/k²) / (m g)
    //   = 0.05962 − 0.004 + 3.136 · 0.28381 / 833.85 = 0.05669
    expect(load.gradient).toBeCloseTo(0.05669, 5);
  });

  it('makes an easier gear feel easier', () => {
    const load = loadWithVirtualGear(climb, { gearFactor: 1 / REAL, mass: MASS, speed: 3 });
    expect(load.gradient).toBeLessThan(climb.gradient);
  });
});
