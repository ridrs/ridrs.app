// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  activityEquipmentEvent,
  activityStateChangedEvent,
  type ControllerButton,
  configSnapshotCapability,
  controllerButtonsChangedEvent,
  type Drivetrain,
  definePlugin,
  drivetrainGearChangedEvent,
  drivetrainShiftRequestedEvent,
  drivetrainVirtualGearCapability,
  type JsonValue,
  type PluginContext,
  type TemporalSeriesWriter,
} from '@ridrs/contracts';
import {
  type Direction,
  drivetrainRatios,
  type GearPosition,
  ratioAt,
  type Shifter,
  shiftDrivetrain,
  teethAt,
} from './drivetrain.ts';
import { GEAR_DEFAULTS, gearRatios, pressesOf, shifted, shiftOf } from './gears.ts';

const DEFAULT_RATIOS = gearRatios();

interface Gears {
  readonly writer: TemporalSeriesWriter;
  /** The bicycle's drivetrain frozen for the ride; the 24 virtual gears of ADR 0055 without one. */
  drivetrain?: Drivetrain;
  ratios: readonly number[];
  /** Without a drivetrain: the virtual gear, 1 … 24. */
  gear: number;
  /** With a drivetrain: the chainring and the sprocket. */
  position: GearPosition;
}

const states = new WeakMap<PluginContext, Gears>();

/** Writes the gear's ratio to the series and tells the HUD, in the turn of the shift. */
function writeRatio(ctx: PluginContext, gears: Gears, ratio: number): void {
  const now = ctx.clock.now();
  const measurement = { value: ratio, measuredAt: now, receivedAt: now, sourceId: ctx.manifest.id };
  if (gears.writer.record(measurement) === 'late') {
    // A second shift within the same millisecond: the gear is a state, the last one counts.
    gears.writer.reset();
    gears.writer.record(measurement);
  }
}

function setGear(ctx: PluginContext, gears: Gears, gear: number): void {
  gears.gear = gear;
  const ratio = gears.ratios[gear - 1] ?? 1;
  writeRatio(ctx, gears, ratio);
  ctx.events.publish(drivetrainGearChangedEvent, { index: gear, ratio, count: gears.ratios.length });
}

function setPosition(
  ctx: PluginContext,
  gears: Gears,
  drivetrain: Drivetrain,
  position: GearPosition,
): void {
  gears.position = position;
  const ratio = ratioAt(drivetrain, position);
  writeRatio(ctx, gears, ratio);
  ctx.events.publish(drivetrainGearChangedEvent, {
    index: gears.ratios.indexOf(ratio) + 1,
    ratio,
    count: gears.ratios.length,
    ...teethAt(drivetrain, position),
    front: position.front,
    rear: position.rear,
  });
}

/**
 * Virtual gears, independent of the trainer protocol. With the bicycle frozen for the ride
 * (`activity.equipment`, ADR 0060) they are its drivetrain, shifted like the Di2 in its mode: the
 * left buttons are the left shifter, the right ones the right shifter, and a shift the rider asks
 * for in the activity screen names its derailleur (the rear without one). Without a bicycle they
 * are the 24 virtual gears of ADR 0055: any shift button shifts one gear. A press shifts once,
 * holding shifts nothing more. The ratio is a temporal series that never goes stale; the physics
 * reads it at its steps, the HUD hears `drivetrain.gear-changed`. Every ride starts in its start
 * gear; a resumed one keeps its gear.
 */
export default definePlugin({
  initialize(ctx) {
    const gears: Gears = {
      writer: ctx.temporal.writer(drivetrainVirtualGearCapability, {
        strategy: 'hold',
        stale: 'never',
      }),
      ratios: DEFAULT_RATIOS,
      gear: GEAR_DEFAULTS.startGear,
      position: { front: 1, rear: 1 },
    };
    states.set(ctx, gears);
    ctx.capabilities.provide(drivetrainVirtualGearCapability, {
      realRatio: GEAR_DEFAULTS.chainring / GEAR_DEFAULTS.cog,
      get ratios() {
        return gears.ratios;
      },
    });
    ctx.capabilities.provide(configSnapshotCapability, {
      section: ctx.manifest.id,
      snapshot: (): JsonValue =>
        gears.drivetrain
          ? {
              chainring: GEAR_DEFAULTS.chainring,
              cog: GEAR_DEFAULTS.cog,
              drivetrain: JSON.parse(JSON.stringify(gears.drivetrain)) as JsonValue,
              ratios: [...gears.ratios],
            }
          : { ...GEAR_DEFAULTS, ratios: [...gears.ratios] },
    });
  },

  start(ctx) {
    const gears = states.get(ctx);
    if (!gears) {
      return;
    }
    const shift = (shifter: Shifter, direction: Direction): void => {
      const drivetrain = gears.drivetrain;
      if (drivetrain) {
        const next = shiftDrivetrain(drivetrain, gears.position, shifter, direction);
        if (next !== gears.position) {
          setPosition(ctx, gears, drivetrain, next);
        }
        return;
      }
      const gear = shifted(gears.gear, direction === 'harder' ? 1 : -1, gears.ratios.length);
      if (gear !== gears.gear) {
        setGear(ctx, gears, gear);
      }
    };

    // The bicycle frozen for a session; it arrives right before the session runs.
    let frozen: { readonly sessionId: string; readonly drivetrain: Drivetrain } | undefined;
    ctx.events.subscribe(activityEquipmentEvent, ({ payload }) => {
      frozen = { sessionId: payload.sessionId, drivetrain: payload.bicycle.drivetrain };
    });

    // A resumed ride runs again in the same session and keeps its gear.
    let session: string | undefined;
    ctx.events.subscribe(activityStateChangedEvent, ({ payload }) => {
      if (payload.state !== 'running' || payload.sessionId === session) {
        return;
      }
      session = payload.sessionId;
      const drivetrain = frozen?.sessionId === session ? frozen.drivetrain : undefined;
      gears.drivetrain = drivetrain;
      if (drivetrain) {
        gears.ratios = drivetrainRatios(drivetrain);
        setPosition(ctx, gears, drivetrain, drivetrain.startGear);
      } else {
        gears.ratios = DEFAULT_RATIOS;
        setGear(ctx, gears, GEAR_DEFAULTS.startGear);
      }
    });

    const held = new Map<string, readonly ControllerButton[]>();
    ctx.events.subscribe(controllerButtonsChangedEvent, ({ payload }) => {
      const before = held.get(payload.deviceId) ?? [];
      held.set(payload.deviceId, payload.buttons);
      if (gears.drivetrain) {
        for (const press of pressesOf(before, payload.buttons)) {
          shift(press.side, press.direction);
        }
        return;
      }
      const by = shiftOf(before, payload.buttons);
      if (by !== 0) {
        const gear = shifted(gears.gear, by, gears.ratios.length);
        if (gear !== gears.gear) {
          setGear(ctx, gears, gear);
        }
      }
    });

    ctx.events.subscribe(drivetrainShiftRequestedEvent, ({ payload }) => {
      shift(payload.derailleur === 'front' ? 'left' : 'right', payload.change === 'up' ? 'harder' : 'easier');
    });
  },
});
