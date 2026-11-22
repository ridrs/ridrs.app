// SPDX-License-Identifier: AGPL-3.0-or-later

import { CONTROLLER_BUTTON_EVENT, type Unsubscribe } from '@ridrs/ui-sdk';

export type InputMode = 'keyboard' | 'pointer';

/** Minimum pointer displacement (CSS px) to switch from keyboard to pointer mode. */
export const POINTER_MOVE_THRESHOLD_PX = 4;

/** Keys that signify keyboard/controller navigation or activation. */
const NAVIGATION_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Tab',
  'Enter',
  ' ',
  'Escape',
  'Backspace',
  'BrowserBack',
  'GoBack',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

export interface InputModalityHandle {
  readonly mode: () => InputMode;
  readonly onChange: (listener: (mode: InputMode) => void) => Unsubscribe;
  /** Fires on genuine pointer activity (down, touch, or movement >= threshold). */
  readonly onPointerActivity: (listener: () => void) => Unsubscribe;
  readonly stop: Unsubscribe;
}

/**
 * Automatically tracks whether the rider is using pointer (mouse/touch) or keyboard/controller
 * (ADR 0107) and reflects the active mode on `document.documentElement.dataset.inputMode`.
 *
 * Zero-movement or sub-threshold `mousemove`/`pointermove` events (such as WebKit firing a hover
 * re-evaluation when a scroll or layout shift moves content under a stationary cursor) are ignored
 * so keyboard/controller navigation never flips back to pointer mode by accident.
 */
export function inputModality(document: Document): InputModalityHandle {
  let current: InputMode = 'keyboard';
  let lastPointer: { x: number; y: number } | undefined;
  const modeListeners = new Set<(mode: InputMode) => void>();
  const pointerListeners = new Set<() => void>();

  const apply = (next: InputMode) => {
    document.documentElement.dataset.inputMode = next;
    if (next === current) {
      return;
    }
    current = next;
    for (const listener of [...modeListeners]) {
      listener(next);
    }
  };

  const notifyPointerActivity = () => {
    for (const listener of [...pointerListeners]) {
      listener();
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    if (NAVIGATION_KEYS.has(event.key)) {
      apply('keyboard');
    }
  };

  const onControllerButton = () => {
    apply('keyboard');
  };

  const onPointerDown = (event: MouseEvent | PointerEvent | TouchEvent) => {
    if ('clientX' in event && 'clientY' in event) {
      lastPointer = { x: event.clientX, y: event.clientY };
    }
    apply('pointer');
    notifyPointerActivity();
  };

  const onPointerMove = (event: MouseEvent | PointerEvent) => {
    const x = event.clientX;
    const y = event.clientY;
    if (!lastPointer) {
      // First pointer coordinates ever seen: establish anchor without flipping on a phantom move.
      lastPointer = { x, y };
      return;
    }
    const distance = Math.hypot(x - lastPointer.x, y - lastPointer.y);
    if (distance < POINTER_MOVE_THRESHOLD_PX) {
      return;
    }
    lastPointer = { x, y };
    apply('pointer');
    notifyPointerActivity();
  };

  apply('keyboard');

  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener(CONTROLLER_BUTTON_EVENT, onControllerButton, true);
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('mousedown', onPointerDown, true);
  document.addEventListener('touchstart', onPointerDown, true);
  document.addEventListener('pointermove', onPointerMove, true);
  document.addEventListener('mousemove', onPointerMove, true);

  return {
    mode: () => current,
    onChange(listener) {
      modeListeners.add(listener);
      return () => {
        modeListeners.delete(listener);
      };
    },
    onPointerActivity(listener) {
      pointerListeners.add(listener);
      return () => {
        pointerListeners.delete(listener);
      };
    },
    stop() {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener(CONTROLLER_BUTTON_EVENT, onControllerButton, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('mousedown', onPointerDown, true);
      document.removeEventListener('touchstart', onPointerDown, true);
      document.removeEventListener('pointermove', onPointerMove, true);
      document.removeEventListener('mousemove', onPointerMove, true);
      modeListeners.clear();
      pointerListeners.clear();
      delete document.documentElement.dataset.inputMode;
    },
  };
}
