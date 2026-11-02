// SPDX-License-Identifier: AGPL-3.0-or-later

import type { PairingState } from '@ridrs/ble-bridge';
import { formatPairingUri } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import { FakeIpc } from '../../../packages/ble-tauri/src/testing/fake-ipc.ts';
import { startCompanion } from './companion.ts';

async function companion() {
  const ipc = new FakeIpc();
  ipc.on('bridge_serve', () => ({ port: 42229, addresses: ['192.168.1.5'] }));
  let state: PairingState | undefined;
  return startCompanion({
    ipc,
    central: { scan: async function* () {}, connect: () => Promise.reject(new Error('none')) },
    name: 'Pixel 8',
    pairingStore: { load: () => state, save: (s) => (state = s) },
    clock: { now: () => 0 },
  });
}

describe('companion QR pairing', () => {
  it('accepts a ridrs pairing QR code and shows whom it waits for', async () => {
    const c = await companion();
    const uri = formatPairingUri({ secret: 'ab'.repeat(16), name: 'ridrs' });
    expect(c.acceptPairingQr(`  ${uri}\n`)).toBe('ridrs');
    expect(c.view().scannedFor).toBe('ridrs');
  });

  it('ignores QR codes that are not ridrs pairing codes', async () => {
    const c = await companion();
    expect(c.acceptPairingQr('https://example.org')).toBeUndefined();
    expect(c.view().scannedFor).toBeUndefined();
  });
});
