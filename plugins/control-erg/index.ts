// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  activityStateChangedEvent,
  type ControllerButton,
  configSnapshotCapability,
  controllerButtonsChangedEvent,
  definePlugin,
  trainerErgRequestedEvent,
  trainerTargetPowerEvent,
  WORKOUT_INTENSITY,
  workoutFinishedEvent,
  workoutIntensityChangedEvent,
  workoutStepChangedEvent,
} from '@ridrs/contracts';
import { type TimelineSegment, workoutTimeline } from '@ridrs/workout';

const ERG_DEFAULTS = Object.freeze({
  /** W, the target ERG starts with. */
  defaultWatts: 150,
  /** W per step of the arrow keys and the power-up buttons. */
  stepWatts: 5,
});

/**
 * The rider's ERG target: a driver, like the world driver. It turns what the rider asks for in
 * the activity screen (`trainer.erg-requested`) and the power-up buttons of a controller into the
 * input `trainer.target-power`, which a replay injects as recorded. The right power-up button
 * starts ERG or raises the target, the left one lowers it. A finished ride leaves ERG.
 *
 * While a step of the ride's workout has a power target, the workout player alone sets the target
 * (structured-workouts.md, section 11a): then plus and minus and the power-up buttons change the
 * workout's intensity instead, by 1 % between 50 % and 150 %, as the input
 * `workout.intensity-changed`, which the player scales the workout's targets by; entering and
 * leaving ERG are ignored. The step comes from `workout.step-changed`, its target from the
 * workout of the activity state, so the HUD can tell the same from the same two events. A new
 * ride starts at 100 %.
 */
export default definePlugin({
  initialize(ctx) {
    ctx.capabilities.provide(configSnapshotCapability, {
      section: ctx.manifest.id,
      snapshot: () => ({ ...ERG_DEFAULTS }),
    });
  },

  start(ctx) {
    /** The target in force, as this driver set it last or heard it from another source. */
    let target: number | null = null;
    const pressed = new Map<string, readonly ControllerButton[]>();

    /** The unrolled steps of the ride's workout, and whether the current one holds the target. */
    let steps: readonly TimelineSegment[] = [];
    let workoutSession: string | undefined;
    let workoutKey: string | undefined;
    let held = false;
    /** % of the workout's targets, as this driver set it last or heard it on the bus. */
    let intensity: number = WORKOUT_INTENSITY.default;

    /** Plus or minus while the workout holds the target: its intensity, within its bounds. */
    const changeIntensity = (change: 'up' | 'down'): void => {
      const step = change === 'up' ? WORKOUT_INTENSITY.step : -WORKOUT_INTENSITY.step;
      const percent = Math.min(WORKOUT_INTENSITY.max, Math.max(WORKOUT_INTENSITY.min, intensity + step));
      if (percent !== intensity) {
        intensity = percent;
        ctx.inputs.accept(workoutIntensityChangedEvent, { percent });
      }
    };

    const set = (watts: number | null): void => {
      if (watts === target) {
        return;
      }
      target = watts;
      ctx.inputs.accept(trainerTargetPowerEvent, { watts });
    };
    const raise = (): void =>
      set(target === null ? ERG_DEFAULTS.defaultWatts : target + ERG_DEFAULTS.stepWatts);
    const lower = (): void => {
      if (target !== null) {
        set(Math.max(0, target - ERG_DEFAULTS.stepWatts));
      }
    };

    ctx.events.subscribe(trainerTargetPowerEvent, ({ payload }) => {
      target = payload.watts;
    });

    ctx.events.subscribe(workoutIntensityChangedEvent, ({ payload }) => {
      intensity = payload.percent;
    });

    ctx.events.subscribe(trainerErgRequestedEvent, ({ payload }) => {
      if (held) {
        if (payload.change === 'up' || payload.change === 'down') {
          changeIntensity(payload.change);
        }
        return;
      }
      switch (payload.change) {
        case 'enter':
          if (target === null) {
            set(ERG_DEFAULTS.defaultWatts);
          }
          return;
        case 'up':
          if (target !== null) {
            raise();
          }
          return;
        case 'down':
          lower();
          return;
        case 'leave':
          set(null);
          return;
      }
    });

    ctx.events.subscribe(controllerButtonsChangedEvent, ({ payload }) => {
      const before = pressed.get(payload.deviceId) ?? [];
      pressed.set(payload.deviceId, payload.buttons);
      for (const button of payload.buttons) {
        if (before.includes(button)) {
          continue;
        }
        if (button === 'power-up-right') {
          held ? changeIntensity('up') : raise();
        } else if (button === 'power-up-left') {
          held ? changeIntensity('down') : lower();
        }
      }
    });

    ctx.events.subscribe(workoutStepChangedEvent, ({ payload }) => {
      const effort = steps[payload.index]?.effort;
      held = effort?.kind === 'target' && effort.primary.unit === 'watts';
    });
    ctx.events.subscribe(workoutFinishedEvent, () => {
      held = false;
    });

    ctx.events.subscribe(activityStateChangedEvent, ({ payload }) => {
      if (payload.state === 'idle' || payload.state === 'finished') {
        steps = [];
        workoutSession = undefined;
        workoutKey = undefined;
        held = false;
        intensity = WORKOUT_INTENSITY.default;
      } else {
        const nextKey = payload.workout ? JSON.stringify(payload.workout.workout) : undefined;
        if (payload.sessionId !== workoutSession || nextKey !== workoutKey) {
          workoutSession = payload.sessionId;
          workoutKey = nextKey;
          steps = payload.workout ? workoutTimeline(payload.workout.workout).segments : [];
          held = false;
          intensity = WORKOUT_INTENSITY.default;
        }
      }
      if (payload.state === 'finished') {
        set(null);
      }
    });
  },
});
