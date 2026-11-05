// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  definePlugin,
  drivetrainVirtualGearCapability,
  type MotionResult,
  physicsBicycleCapability,
  physicsEnvironmentCapability,
  physicsRiderCapability,
  physicsTrainerLoadCapability,
  SURFACE_ROLLING_FACTORS,
  type TrainerLoad,
  type TrainerLoadSample,
} from '@ridrs/contracts';
import { loadWithVirtualGear } from './trainer-load.ts';

/**
 * What a trainer should feel at each step: the virtual bike's load as FTMS simulation parameters,
 * without and with the virtual gear. It reads the gear through the temporal layer when a gear
 * source is installed, subscribes to nothing and knows no trainer, mode or capability.
 */
export default definePlugin({
  initialize(ctx) {
    const gears = ctx.temporal.reader(drivetrainVirtualGearCapability);

    const gearAt = (at: number): TrainerLoadSample['virtualGear'] & { factor: number } | undefined => {
      const drivetrain = ctx.capabilities.find(drivetrainVirtualGearCapability);
      const read = gears.valueAt(at);
      if (!drivetrain || read.status !== 'available') {
        return undefined;
      }
      const ratio = read.value;
      const index = drivetrain.ratios.indexOf(ratio) + 1;
      return index > 0 ? { index, ratio, factor: ratio / drivetrain.realRatio } : undefined;
    };

    ctx.capabilities.provide(physicsTrainerLoadCapability, {
      load(state: MotionResult): TrainerLoadSample {
        const crr = ctx.capabilities.get(physicsBicycleCapability).parameters()
          .rollingResistanceCoefficient.value;
        const cdA = ctx.capabilities.get(physicsRiderCapability).parameters().cdA.value;
        const airDensity = ctx.capabilities.get(physicsEnvironmentCapability).parameters()
          .airDensity.value;
        const resistance: TrainerLoad = {
          gradient: state.road.gradient,
          rollingResistanceCoefficient: crr * SURFACE_ROLLING_FACTORS[state.road.surface],
          windResistanceCoefficient: airDensity * cdA,
          windSpeed: 0,
        };
        const gear = gearAt(state.at);
        if (!gear) {
          return { resistance, resistanceWithVirtualGear: resistance };
        }
        return {
          resistance,
          resistanceWithVirtualGear: loadWithVirtualGear(resistance, {
            gearFactor: gear.factor,
            mass: state.mass,
            speed: state.speed,
          }),
          virtualGear: { index: gear.index, ratio: gear.ratio },
        };
      },
    });
  },
});
