// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  CONTROLLER_BINDINGS_KEY,
  type ControllerBindings,
  type ControllerButton,
  type ControllerCommand,
  controllerBindingsSchema,
  controllerBindingsState,
  controllerButtonsChangedEvent,
  DEFAULT_CONTROLLER_BINDINGS,
  type UiRegistry,
} from '@ridrs/contracts';
import {
  CONTROLLER_BUTTON_EVENT,
  type ControllerButtonEventDetail,
  type UiBridge,
  type Unsubscribe,
} from '@ridrs/ui-sdk';

/** The key each command presses: what `keyboardNavigation` and the screens already understand. */
const KEYS: Record<ControllerCommand, string> = {
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  confirm: 'Enter',
  back: 'Escape',
};

/** The arrows repeat while held, as a key does: after this long first, then at this pace. */
export const REPEAT_DELAY_MS = 400;
export const REPEAT_INTERVAL_MS = 120;

const REPEATS: ReadonlySet<ControllerCommand> = new Set(['up', 'down', 'left', 'right']);

/** What Enter activates in a browser: the element clicks itself. */
function activates(element: Element): element is HTMLElement {
  const role = element.getAttribute('role');
  return (
    element.localName === 'button' ||
    element.localName === 'a' ||
    role === 'button' ||
    role === 'tab'
  );
}

/**
 * Turns the buttons of every controller into the keys of the rider's bindings (ADR 0098), so the
 * controller works wherever the keys do: a press dispatches `CONTROLLER_BUTTON_EVENT` on the
 * document and, unless a component took the button, `keydown` of the bound key on the focused
 * element. A synthetic Enter has no default action, so the shell clicks the focused button when no
 * one handled the key. Arrows repeat while held. Does nothing while no UI plugin lets the
 * client see `controller.buttons-changed`; uses the default bindings while no one owns
 * `controller.bindings`.
 */
export function controllerKeys(document: Document, bridge: UiBridge): Unsubscribe {
  const view = document.defaultView;
  let bindings: ControllerBindings = DEFAULT_CONTROLLER_BINDINGS;
  /** The buttons each controller holds, by device id. */
  const held = new Map<string, readonly ControllerButton[]>();
  const repeats = new Map<string, ReturnType<typeof setTimeout>>();
  let stopButtons: Unsubscribe | undefined;
  let stopBindings: Unsubscribe | undefined;

  const commandOf = (button: ControllerButton): ControllerCommand | undefined =>
    (Object.keys(bindings) as ControllerCommand[]).find((c) => bindings[c] === button);

  const pressKey = (command: ControllerCommand): void => {
    const target = document.activeElement ?? document.body;
    const key = KEYS[command];
    const KeyboardEventOf = view?.KeyboardEvent ?? KeyboardEvent;
    const handled = !target.dispatchEvent(
      new KeyboardEventOf('keydown', { key, bubbles: true, cancelable: true }),
    );
    if (!handled && command === 'confirm' && target !== document.body && activates(target)) {
      target.click();
    }
  };

  const stopRepeat = (id: string): void => {
    const timer = repeats.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      repeats.delete(id);
    }
  };

  const press = (deviceId: string, button: ControllerButton): void => {
    const CustomEventOf = view?.CustomEvent ?? CustomEvent;
    const detail: ControllerButtonEventDetail = { button };
    const free = document.dispatchEvent(
      new CustomEventOf(CONTROLLER_BUTTON_EVENT, { detail, cancelable: true }),
    );
    const command = commandOf(button);
    if (!free || !command) {
      return;
    }
    pressKey(command);
    if (REPEATS.has(command)) {
      const id = `${deviceId}/${button}`;
      const again = (delay: number) => {
        repeats.set(
          id,
          setTimeout(() => {
            pressKey(command);
            again(REPEAT_INTERVAL_MS);
          }, delay),
        );
      };
      again(REPEAT_DELAY_MS);
    }
  };

  const attach = (registry: UiRegistry): void => {
    if (!stopBindings && registry.state.includes(controllerBindingsState.id)) {
      stopBindings = bridge.watchState(controllerBindingsState.id, (update) => {
        if (update.removed.includes(CONTROLLER_BINDINGS_KEY)) {
          bindings = DEFAULT_CONTROLLER_BINDINGS;
        }
        if (CONTROLLER_BINDINGS_KEY in update.values) {
          const parsed = controllerBindingsSchema.safeParse(update.values[CONTROLLER_BINDINGS_KEY]);
          bindings = parsed.success ? parsed.data : DEFAULT_CONTROLLER_BINDINGS;
        }
      });
    }
    if (!stopButtons && registry.events.subscribe.includes(controllerButtonsChangedEvent.id)) {
      // The bridge hands over the latest buttons first: what was held before is no press.
      let replaying = true;
      stopButtons = bridge.subscribe(controllerButtonsChangedEvent.id, ({ payload }) => {
        const parsed = controllerButtonsChangedEvent.schema.safeParse(payload);
        if (!parsed.success) {
          return;
        }
        const { deviceId, buttons } = parsed.data;
        const before = held.get(deviceId) ?? [];
        held.set(deviceId, buttons);
        for (const button of before) {
          if (!buttons.includes(button)) {
            stopRepeat(`${deviceId}/${button}`);
          }
        }
        if (replaying) {
          return;
        }
        for (const button of buttons) {
          if (!before.includes(button)) {
            press(deviceId, button);
          }
        }
      });
      replaying = false;
    }
  };

  attach(bridge.registry());
  const stopRegistry = bridge.onRegistryChanged(attach);

  return () => {
    stopRegistry();
    stopButtons?.();
    stopBindings?.();
    for (const id of [...repeats.keys()]) {
      stopRepeat(id);
    }
  };
}
