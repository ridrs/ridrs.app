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

const PAIRING_SECRET = 'companion.state';
const LEGACY_PAIRING_KEY = 'ridrs.companion.pairing';

function parsePairing(raw: string | null | undefined): PairingState | undefined {
  try {
    return raw ? (JSON.parse(raw) as PairingState) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The companion id and issued tokens survive restarts in the app's secret store (ADR 0053), read
 * once at start; a state left in the WebView's storage by an older companion moves there once.
 * Without the store the companion forgets its pairings on restart; ridrs pairs again.
 */
export async function secretPairingStore(): Promise<PairingStore> {
  let state = parsePairing(
    await invoke<string | null>('secret_get', { key: PAIRING_SECRET }).catch(() => null),
  );
  const legacy = parsePairing(read(LEGACY_PAIRING_KEY));
  if (!state && legacy) {
    state = legacy;
    await invoke('secret_set', { key: PAIRING_SECRET, value: JSON.stringify(legacy) })
      .then(() => localStorage.removeItem(LEGACY_PAIRING_KEY))
      .catch((error: unknown) => console.warn('pairing could not move to the secret store', error));
  }
  let saving = Promise.resolve();
  return {
    load: () => state,
    save: (next) => {
      state = next;
      const value = JSON.stringify(next);
      saving = saving
        .then(() => invoke<void>('secret_set', { key: PAIRING_SECRET, value }))
        .catch((error: unknown) => console.warn('pairing could not be saved', error));
    },
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
