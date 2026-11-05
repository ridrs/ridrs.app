// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  activityStateChangedEvent,
  type ControllerButton,
  configSnapshotCapability,
  controllerButtonsChangedEvent,
  definePlugin,
  drivetrainGearChangedEvent,
  drivetrainShiftRequestedEvent,
  drivetrainVirtualGearCapability,
  type PluginContext,
  type TemporalSeriesWriter,
} from '@ridrs/contracts';
import { GEAR_DEFAULTS, gearRatios, shifted, shiftOf } from './gears.ts';

interface Gears {
  readonly writer: TemporalSeriesWriter;
  readonly ratios: readonly number[];
  gear: number;
}

const states = new WeakMap<PluginContext, Gears>();

/** Writes the gear's ratio to the series and tells the HUD, in the turn of the shift. */
function setGear(ctx: PluginContext, gears: Gears, gear: number): void {
  gears.gear = gear;
  const ratio = gears.ratios[gear - 1] ?? 1;
  const now = ctx.clock.now();
  const measurement = { value: ratio, measuredAt: now, receivedAt: now, sourceId: ctx.manifest.id };
  if (gears.writer.record(measurement) === 'late') {
    // A second shift within the same millisecond: the gear is a state, the last one counts.
    gears.writer.reset();
    gears.writer.record(measurement);
  }
  ctx.events.publish(drivetrainGearChangedEvent, {
    index: gear,
    ratio,
    count: gears.ratios.length,
  });
}

/**
 * Virtual gears, independent of the trainer protocol: a press of a shift button of any controller
 * shifts one gear, holding shifts nothing more, and so does a shift the rider asks for in the
 * activity screen (`drivetrain.shift-requested`). The gear is a temporal series that never goes
 * stale; the physics reads it at its steps, the HUD hears `drivetrain.gear-changed`. Every ride
 * starts in the start gear; a resumed one keeps its gear.
 */
export default definePlugin({
  initialize(ctx) {
    const ratios = gearRatios();
    const gears: Gears = {
      writer: ctx.temporal.writer(drivetrainVirtualGearCapability, {
        strategy: 'hold',
        stale: 'never',
      }),
      ratios,
      gear: GEAR_DEFAULTS.startGear,
    };
    states.set(ctx, gears);
    ctx.capabilities.provide(drivetrainVirtualGearCapability, {
      realRatio: GEAR_DEFAULTS.chainring / GEAR_DEFAULTS.cog,
      ratios,
    });
    ctx.capabilities.provide(configSnapshotCapability, {
      section: ctx.manifest.id,
      snapshot: () => ({ ...GEAR_DEFAULTS, ratios: [...ratios] }),
    });
  },

  start(ctx) {
    const gears = states.get(ctx);
    if (!gears) {
      return;
    }
    const held = new Map<string, readonly ControllerButton[]>();
    const shift = (by: number): void => {
      const gear = shifted(gears.gear, by, gears.ratios.length);
      if (gear !== gears.gear) {
        setGear(ctx, gears, gear);
      }
    };

    // A resumed ride runs again in the same session and keeps its gear.
    let session: string | undefined;
    ctx.events.subscribe(activityStateChangedEvent, ({ payload }) => {
      if (payload.state === 'running' && payload.sessionId !== session) {
        session = payload.sessionId;
        setGear(ctx, gears, GEAR_DEFAULTS.startGear);
      }
    });

    ctx.events.subscribe(controllerButtonsChangedEvent, ({ payload }) => {
      const before = held.get(payload.deviceId) ?? [];
      held.set(payload.deviceId, payload.buttons);
      shift(shiftOf(before, payload.buttons));
    });

    ctx.events.subscribe(drivetrainShiftRequestedEvent, ({ payload }) => {
      shift(payload.change === 'up' ? 1 : -1);
    });
  },
});
