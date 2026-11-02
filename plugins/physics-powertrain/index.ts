// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  definePlugin,
  metricPowerCapability,
  type PowertrainOutput,
  physicsPowertrainCapability,
  type TemporalValue,
} from '@ridrs/contracts';

/** 0 % loss: with the default, results equal a direct rider-power model. */
export const POWERTRAIN_DEFAULTS = Object.freeze({ efficiency: 1.0 });

/**
 * Rider power to wheel power. Missing power means no drive: the physics never invents, holds or
 * extrapolates power itself - estimation is the temporal data layer's job.
 */
export function wheelPowerOf(riderPower: TemporalValue, efficiency: number): PowertrainOutput {
  return {
    riderPower,
    wheelPower: riderPower.status === 'available' ? efficiency * riderPower.value : 0,
    efficiency,
  };
}

/** Reads the measured rider power at the step time from the `metric.power` series. */
export default definePlugin({
  initialize(ctx) {
    const power = ctx.temporal.reader(metricPowerCapability);
    ctx.capabilities.provide(physicsPowertrainCapability, {
      wheelPower: (at) => wheelPowerOf(power.valueAt(at), POWERTRAIN_DEFAULTS.efficiency),
    });
  },
});
