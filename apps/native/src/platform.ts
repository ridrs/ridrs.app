// SPDX-License-Identifier: AGPL-3.0-or-later

import { invoke } from '@tauri-apps/api/core';
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
