// SPDX-License-Identifier: AGPL-3.0-or-later

import type { FullscreenPort } from '@ridrs/ui-shell';
import { onBackButtonPress } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { KeepAwakePort } from './compose.ts';

/** Android needs the "Nearby devices" grant before a scan finds anything; elsewhere this is `true`. */
export function ensureBluetoothPermission(): Promise<boolean> {
  return invoke<boolean>('ble_check_permissions', { askIfDenied: true });
}

/**
 * Desktop: the OS mechanism via the `keep_awake` command. Mobile: the Screen Wake Lock API of the
 * WebView, since the command reports "unsupported" there.
 */
export function createKeepAwake(): KeepAwakePort {
  let wakeLock: WakeLockSentinel | undefined;
  let wanted = false;

  const apply = async (on: boolean) => {
    const mode = await invoke<'native' | 'unsupported'>('keep_awake', { enabled: on });
    if (mode === 'native') {
      return;
    }
    if (on && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = undefined;
      });
    } else if (!on) {
      await wakeLock?.release();
    }
  };

  // The browser drops a wake lock when the page is hidden; take it again when the ride continues.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && wanted) {
      void apply(true).catch(() => undefined);
    }
  });

  return {
    setKeepAwake(on) {
      wanted = on;
      void apply(on).catch((error: unknown) => console.warn('keep-awake failed', error));
    },
  };
}

/**
 * Android's back button and gesture. Listening takes over its default, so the app no longer closes
 * on Back; the shell decides. Elsewhere there is no back button and registering fails quietly.
 */
export function androidBackButton(press: () => void): () => void {
  const listening = onBackButtonPress(() => press()).catch(() => undefined);
  return () => {
    void listening.then((listener) => listener?.unregister());
  };
}

/**
 * Native desktop fullscreen & cursor bridge: macOS native fullscreen does not set
 * `document.fullscreenElement`, and WebKit's CSS `cursor: none` does not refresh while the mouse
 * is stationary. Tauri's `isFullscreen()` + `setCursorVisible()` bridge both reliably (ADR 0107).
 * On mobile (no desktop window fullscreen/cursor), calls fail quietly.
 */
export function createNativeFullscreen(): FullscreenPort {
  const win = getCurrentWindow();
  return {
    isFullscreen: () => win.isFullscreen().catch(() => false),
    onChange(listener) {
      let last: boolean | undefined;
      let stopped = false;
      const check = () => {
        void win
          .isFullscreen()
          .then((fullscreen) => {
            if (!stopped && fullscreen !== last) {
              last = fullscreen;
              listener(fullscreen);
            }
          })
          .catch(() => undefined);
      };
      const listening = win.onResized(check).catch(() => undefined);
      window.addEventListener('resize', check);
      return () => {
        stopped = true;
        window.removeEventListener('resize', check);
        void listening.then((unlisten) => unlisten?.());
      };
    },
    setCursorVisible: (visible) => win.setCursorVisible(visible).catch(() => undefined),
  };
}
