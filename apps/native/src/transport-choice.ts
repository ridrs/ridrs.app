// SPDX-License-Identifier: AGPL-3.0-or-later

import { type BleTransport, bleTransportSchema } from '@ridrs/contracts';

/** Durable storage of the choice (a file written by Rust in the app); faked in tests. */
export interface TransportStore {
  read(): Promise<string | null>;
  write(transport: BleTransport): Promise<void>;
}

/** The saved choice; anything missing, unreadable or unknown means this device's Bluetooth. */
export async function loadTransport(store: TransportStore): Promise<BleTransport> {
  try {
    const parsed = bleTransportSchema.safeParse(await store.read());
    return parsed.success ? parsed.data : 'local';
  } catch {
    return 'local';
  }
}

/**
 * Saves the choice and confirms it reads back: only then may the app restart into it. Throws
 * otherwise, and the app keeps running in its current transport.
 */
export async function saveTransport(store: TransportStore, transport: BleTransport): Promise<void> {
  await store.write(transport);
  const stored = await loadTransport(store);
  if (stored !== transport) {
    throw new Error(`The BLE transport choice did not persist (read back "${stored}")`);
  }
}
