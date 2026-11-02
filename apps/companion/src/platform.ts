// SPDX-License-Identifier: AGPL-3.0-or-later

import type { PairingState, PairingStore } from '@ridrs/ble-bridge';
import { Channel, invoke } from '@tauri-apps/api/core';
import { Format, scan } from '@tauri-apps/plugin-barcode-scanner';
import type { CompanionIpc } from './ipc-server.ts';

export function createCompanionIpc(): CompanionIpc {
  return {
    invoke: (command, args) => invoke(command, args),
    createChannel: <T>() => new Channel<T>(),
  };
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Without storage the companion forgets its pairings on restart; ridrs pairs again.
  }
}

/** The companion id and issued tokens survive restarts; reinstalling the app resets them. */
export function webStoragePairingStore(): PairingStore {
  const key = 'ridrs.companion.pairing';
  return {
    load: () => {
      const raw = read(key);
      return raw ? (JSON.parse(raw) as PairingState) : undefined;
    },
    save: (state) => write(key, JSON.stringify(state)),
  };
}

const NAME_KEY = 'ridrs.companion.name';

export function companionName(): string {
  return read(NAME_KEY) ?? 'ridrs companion';
}

export function saveCompanionName(name: string): void {
  write(NAME_KEY, name);
}

/** Android needs the "Nearby devices" grant before a scan finds anything; elsewhere `true`. */
export function ensureBluetoothPermission(): Promise<boolean> {
  return invoke<boolean>('ble_check_permissions', { askIfDenied: true });
}

/**
 * Keeps the screen on while the companion runs. On Android the activity does this natively
 * (with the screen off the app loses the network); the Wake Lock covers the other platforms.
 */
export function keepScreenOn(): void {
  const request = () => {
    if ('wakeLock' in navigator) {
      void navigator.wakeLock.request('screen').catch(() => undefined);
    }
  };
  request();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') request();
  });
}

/**
 * Opens the camera and resolves with the text of the first QR code; rejects when cancelled or
 * where no scanner exists (desktop builds are for development only).
 */
export async function scanQrCode(): Promise<string> {
  const result = await scan({ windowed: false, formats: [Format.QRCode] });
  return result.content;
}
