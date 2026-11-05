// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  activityStateChangedEvent,
  type ControllerButton,
  configSnapshotCapability,
  controllerButtonsChangedEvent,
  definePlugin,
  trainerErgRequestedEvent,
  trainerTargetPowerEvent,
} from '@ridrs/contracts';

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
    const held = new Map<string, readonly ControllerButton[]>();

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

    ctx.events.subscribe(trainerErgRequestedEvent, ({ payload }) => {
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
      const before = held.get(payload.deviceId) ?? [];
      held.set(payload.deviceId, payload.buttons);
      for (const button of payload.buttons) {
        if (before.includes(button)) {
          continue;
        }
        if (button === 'power-up-right') {
          raise();
        } else if (button === 'power-up-left') {
          lower();
        }
      }
    });

    ctx.events.subscribe(activityStateChangedEvent, ({ payload }) => {
      if (payload.state === 'finished') {
        set(null);
      }
    });
  },
});
