// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, it } from 'vitest';
import { encodeNotificationFrame } from '../src/ble/frame.ts';
import { TauriBleCentral } from '../src/ble/tauri-ble-central.ts';
import { type ProbeEvent, startFtmsPluginProbe } from '../src/probe/ftms-plugin-probe.ts';
import { FakeIpc, flush } from './fake-ipc.ts';

it('stage 2: the real device-ftms-trainer plugin publishes power and cadence through TauriBleCentral', async () => {
  const ipc = new FakeIpc();
  const events: ProbeEvent[] = [];
  const probe = await startFtmsPluginProbe(new TauriBleCentral(ipc), (e) => events.push(e), () => undefined);
  await flush();

  ipc.channel<object>('ble_scan', 'onEvent').onmessage({
    peripheralId: 'kickr',
    name: 'KICKR CORE',
    serviceUuids: ['00001826-0000-1000-8000-00805f9b34fb'],
    rssi: -50,
  });
  await flush();
  await flush();
  expect(ipc.callsOf('ble_connect')[0]?.args.peripheralId).toBe('kickr');

  // Flags 0x0044: speed present (bit 0 = 0), cadence (bit 2), power (bit 6). 90 rpm, 200 W.
  const packet = new Uint8Array([0x44, 0x00, 0xe8, 0x03, 0xb4, 0x00, 0xc8, 0x00]);
  ipc.channel<ArrayBuffer>('ble_subscribe', 'onNotification').onmessage(encodeNotificationFrame(1, 2, packet));

  expect(events.map((e) => e.type)).toEqual([
    'device.connection-changed',
    'device.connection-changed',
    'device.connection-changed',
    'measurement.power',
    'measurement.cadence',
  ]);
  expect(events.at(-2)?.payload).toMatchObject({ value: 200, deviceId: 'kickr' });
  expect(events.at(-1)?.payload).toMatchObject({ value: 90 });

  await probe.stop();
  expect(ipc.callsOf('ble_disconnect')).toHaveLength(1);
});
