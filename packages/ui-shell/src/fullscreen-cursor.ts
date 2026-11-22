// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Unsubscribe } from '@ridrs/ui-sdk';
import type { InputModalityHandle } from './input-modality.ts';

/** How long the pointer stays idle in fullscreen before hiding. */
export const CURSOR_HIDE_TIMEOUT_MS = 2500;

/**
 * Host window fullscreen and native cursor bridge (e.g. Tauri desktop on macOS, where native
 * window fullscreen does not set `document.fullscreenElement` and WebKit's CSS `cursor: none`
 * does not update while the mouse is stationary).
 */
export interface FullscreenPort {
  /** Whether the host window is currently in fullscreen. */
  isFullscreen(): Promise<boolean> | boolean;
  /** Calls `listener` whenever the host window enters or leaves fullscreen. */
  onChange?(listener: (fullscreen: boolean) => void): Unsubscribe;
  /** Hides or shows the OS cursor directly. */
  setCursorVisible?(visible: boolean): Promise<void> | void;
}

export interface FullscreenCursorOptions {
  readonly port?: FullscreenPort;
  readonly timeoutMs?: number;
}

/**
 * Hides the mouse cursor in fullscreen after a short period without pointer movement, and
 * immediately when switching to keyboard/controller navigation in fullscreen (ADR 0107).
 * Restores the cursor on real pointer movement, window blur, leaving fullscreen, or teardown.
 */
export function fullscreenCursor(
  document: Document,
  modality: InputModalityHandle,
  options: FullscreenCursorOptions = {},
): Unsubscribe {
  const view = document.defaultView;
  const timeoutMs = options.timeoutMs ?? CURSOR_HIDE_TIMEOUT_MS;
  const port = options.port;
  let domFullscreen = Boolean(document.fullscreenElement);
  let hostFullscreen = false;
  let windowBlurred = false;
  let hidden = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const isFullscreen = () => domFullscreen || hostFullscreen;

  const clearTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const setHidden = (next: boolean) => {
    if (next === hidden) {
      return;
    }
    hidden = next;
    document.documentElement.toggleAttribute('data-cursor-hidden', next);
    if (port?.setCursorVisible) {
      void Promise.resolve(port.setCursorVisible(!next)).catch(() => undefined);
    }
  };

  const scheduleHide = () => {
    clearTimer();
    if (!disposed && isFullscreen() && !windowBlurred) {
      timer = setTimeout(() => {
        timer = undefined;
        if (!disposed && isFullscreen() && !windowBlurred) {
          setHidden(true);
        }
      }, timeoutMs);
    }
  };

  const syncFullscreen = (wasFullscreen: boolean) => {
    const now = isFullscreen();
    if (now === wasFullscreen) {
      return;
    }
    if (!now) {
      clearTimer();
      setHidden(false);
    } else if (modality.mode() === 'keyboard' && !windowBlurred) {
      clearTimer();
      setHidden(true);
    } else {
      scheduleHide();
    }
  };

  const onDomFullscreenChange = () => {
    const was = isFullscreen();
    domFullscreen = Boolean(document.fullscreenElement);
    syncFullscreen(was);
  };

  const onWindowBlur = () => {
    windowBlurred = true;
    clearTimer();
    setHidden(false);
  };

  const onWindowFocus = () => {
    windowBlurred = false;
    if (isFullscreen()) {
      if (modality.mode() === 'keyboard') {
        setHidden(true);
      } else {
        scheduleHide();
      }
    }
  };

  const stopPointer = modality.onPointerActivity(() => {
    setHidden(false);
    if (isFullscreen()) {
      scheduleHide();
    }
  });

  const stopMode = modality.onChange((mode) => {
    if (mode === 'keyboard' && isFullscreen() && !windowBlurred) {
      clearTimer();
      setHidden(true);
    }
  });

  const stopHostFullscreen = port?.onChange?.((next) => {
    if (disposed) {
      return;
    }
    const was = isFullscreen();
    hostFullscreen = next;
    syncFullscreen(was);
  });

  document.addEventListener('fullscreenchange', onDomFullscreenChange);
  view?.addEventListener('blur', onWindowBlur);
  view?.addEventListener('focus', onWindowFocus);

  // Query initial fullscreen state (may be sync or async in Tauri).
  if (port) {
    void Promise.resolve(port.isFullscreen())
      .then((initial) => {
        if (disposed) {
          return;
        }
        const was = isFullscreen();
        hostFullscreen = initial;
        syncFullscreen(was);
      })
      .catch(() => undefined);
  } else if (isFullscreen()) {
    scheduleHide();
  }

  return () => {
    disposed = true;
    clearTimer();
    stopPointer();
    stopMode();
    stopHostFullscreen?.();
    document.removeEventListener('fullscreenchange', onDomFullscreenChange);
    view?.removeEventListener('blur', onWindowBlur);
    view?.removeEventListener('focus', onWindowFocus);
    setHidden(false);
  };
}
