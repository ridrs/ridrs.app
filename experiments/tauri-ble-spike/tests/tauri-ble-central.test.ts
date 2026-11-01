// SPDX-License-Identifier: AGPL-3.0-or-later

import type { BleDiscoveredPeripheral } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import { encodeNotificationFrame } from '../src/ble/frame.ts';
import { TauriBleCentral } from '../src/ble/tauri-ble-central.ts';
import { FakeIpc, flush } from './fake-ipc.ts';

const FTMS_128 = '00001826-0000-1000-8000-00805f9b34fb';

function scanEvent(peripheralId: string, serviceUuids = [FTMS_128]) {
  return { peripheralId, name: `dev-${peripheralId}`, serviceUuids, rssi: -60 };
}

describe('TauriBleCentral.scan', () => {
  it('normalizes UUIDs on the way in and out and yields each peripheral once', async () => {
    const ipc = new FakeIpc();
    const central = new TauriBleCentral(ipc);
    const controller = new AbortController();
    const seen: BleDiscoveredPeripheral[] = [];

    const done = (async () => {
      for await (const peripheral of central.scan({
        serviceUuids: ['0x1826'],
        signal: controller.signal,
      })) {
        seen.push(peripheral);
        if (seen.length === 2) {
          controller.abort();
        }
      }
    })();
    await flush();

    expect(ipc.callsOf('ble_scan')[0]?.args.serviceUuids).toEqual(['1826']);
    const channel = ipc.channel<ReturnType<typeof scanEvent>>('ble_scan', 'onEvent');
    channel.onmessage(scanEvent('a'));
    channel.onmessage(scanEvent('a'));
    channel.onmessage(scanEvent('b'));
    await done;

    expect(seen.map((p) => p.peripheralId)).toEqual(['a', 'b']);
    expect(seen[0]?.serviceUuids).toEqual(['1826']);
  });

  it('stops the native scan and ends iteration when the signal aborts', async () => {
    const ipc = new FakeIpc();
    const central = new TauriBleCentral(ipc);
    const controller = new AbortController();
    const seen: string[] = [];

    const done = (async () => {
      for await (const peripheral of central.scan({ serviceUuids: ['1826'], signal: controller.signal })) {
        seen.push(peripheral.peripheralId);
      }
    })();
    await flush();
    controller.abort();
    await done;

    ipc.channel<ReturnType<typeof scanEvent>>('ble_scan', 'onEvent').onmessage(scanEvent('late'));
    expect(seen).toEqual([]);
    expect(ipc.callsOf('ble_stop_scan')).toHaveLength(1);
  });

  it('does not start a native scan for an already aborted signal', async () => {
    const ipc = new FakeIpc();
    const central = new TauriBleCentral(ipc);
    const controller = new AbortController();
    controller.abort();

    for await (const _ of central.scan({ serviceUuids: ['1826'], signal: controller.signal })) {
      throw new Error('must not yield');
    }
    expect(ipc.callsOf('ble_scan')).toHaveLength(0);
  });

  it('stops the native scan when the consumer breaks out of the loop', async () => {
    const ipc = new FakeIpc();
    const central = new TauriBleCentral(ipc);
    const done = (async () => {
      for await (const _ of central.scan({ serviceUuids: ['1826'] })) {
        break;
      }
    })();
    await flush();
    ipc.channel<ReturnType<typeof scanEvent>>('ble_scan', 'onEvent').onmessage(scanEvent('a'));
    await done;
    expect(ipc.callsOf('ble_stop_scan')).toHaveLength(1);
  });
});

describe('TauriBleConnection', () => {
  it('delivers notifications until unsubscribed, then tells Rust to unsubscribe', async () => {
    const ipc = new FakeIpc();
    const connection = await new TauriBleCentral(ipc).connect('trainer');
    const received: number[][] = [];

    const unsubscribe = await connection.subscribe(
      { serviceUuid: FTMS_128, characteristicUuid: '0x2AD2' },
      (data) => received.push([...data]),
    );
    const subscribeArgs = ipc.callsOf('ble_subscribe')[0]?.args;
    expect(subscribeArgs).toMatchObject({
      peripheralId: 'trainer',
      serviceUuid: '1826',
      characteristicUuid: '2ad2',
    });

    const channel = ipc.channel<ArrayBuffer>('ble_subscribe', 'onNotification');
    channel.onmessage(encodeNotificationFrame(1, 2, new Uint8Array([0x44, 0x00])));
    unsubscribe();
    channel.onmessage(encodeNotificationFrame(3, 4, new Uint8Array([0x45, 0x00])));
    unsubscribe();
    await flush();

    expect(received).toEqual([[0x44, 0x00]]);
    expect(ipc.callsOf('ble_unsubscribe')).toHaveLength(1);
  });

  it('exposes the Rust receive timestamps through subscribeTimed', async () => {
    const ipc = new FakeIpc();
    let jsNow = 1_000.5;
    const connection = await new TauriBleCentral(ipc, { wallClockMs: () => jsNow }).connect('trainer');
    const frames: { rustWallMs: number; jsWallMs: number; rustMonotonicUs: number }[] = [];
    await connection.subscribeTimed({ serviceUuid: '1826', characteristicUuid: '2ad2' }, (n) =>
      frames.push(n),
    );
    jsNow = 1_002.0;
    ipc
      .channel<ArrayBuffer>('ble_subscribe', 'onNotification')
      .onmessage(encodeNotificationFrame(123_456, 1_001.25, new Uint8Array([1])));

    expect(frames[0]).toMatchObject({ rustMonotonicUs: 123_456, rustWallMs: 1_001.25, jsWallMs: 1_002.0 });
  });

  it('fires onDisconnected exactly once per connection loss', async () => {
    const ipc = new FakeIpc();
    const connection = await new TauriBleCentral(ipc).connect('trainer');
    let calls = 0;
    connection.onDisconnected(() => {
      calls += 1;
    });
    const lost = ipc.channel<{ peripheralId: string }>('ble_connect', 'onConnectionLost');
    lost.onmessage({ peripheralId: 'trainer' });
    lost.onmessage({ peripheralId: 'trainer' });
    expect(calls).toBe(1);
  });

  it('does not report a user-initiated disconnect as a connection loss', async () => {
    const ipc = new FakeIpc();
    const connection = await new TauriBleCentral(ipc).connect('trainer');
    let calls = 0;
    connection.onDisconnected(() => {
      calls += 1;
    });
    await connection.disconnect();
    ipc.channel<{ peripheralId: string }>('ble_connect', 'onConnectionLost').onmessage({ peripheralId: 'trainer' });
    expect(calls).toBe(0);
    expect(ipc.callsOf('ble_disconnect')[0]?.args).toEqual({ peripheralId: 'trainer' });
  });

  it('removes an onDisconnected listener through the returned function', async () => {
    const ipc = new FakeIpc();
    const connection = await new TauriBleCentral(ipc).connect('trainer');
    let calls = 0;
    const off = connection.onDisconnected(() => {
      calls += 1;
    });
    off();
    ipc.channel<{ peripheralId: string }>('ble_connect', 'onConnectionLost').onmessage({ peripheralId: 'trainer' });
    expect(calls).toBe(0);
  });

  it('rejects connect for an aborted signal and disconnects a connection that completes after abort', async () => {
    const ipc = new FakeIpc();
    const central = new TauriBleCentral(ipc);
    const aborted = new AbortController();
    aborted.abort();
    await expect(central.connect('trainer', { signal: aborted.signal })).rejects.toThrow(/abort/i);
    expect(ipc.callsOf('ble_connect')).toHaveLength(0);

    const controller = new AbortController();
    ipc.on('ble_connect', () => {
      controller.abort();
    });
    await expect(central.connect('trainer', { signal: controller.signal })).rejects.toThrow(/abort/i);
    expect(ipc.callsOf('ble_disconnect')).toHaveLength(1);
  });

  it('writes bytes with and without response through the experiment-local extension', async () => {
    const ipc = new FakeIpc();
    const connection = await new TauriBleCentral(ipc).connect('trainer');
    await connection.write({ serviceUuid: '1826', characteristicUuid: '2AD9' }, new Uint8Array([0x00]), {
      withResponse: true,
    });
    await connection.write(
      {
        serviceUuid: '00000001-19CA-4651-86E5-FA29DCDD09D1',
        characteristicUuid: '00000003-19ca-4651-86e5-fa29dcdd09d1',
      },
      new Uint8Array([0x52, 0x69]),
      { withResponse: false },
    );
    expect(ipc.callsOf('ble_write').map((c) => c.args)).toEqual([
      {
        peripheralId: 'trainer',
        serviceUuid: '1826',
        characteristicUuid: '2ad9',
        data: [0x00],
        withResponse: true,
      },
      {
        peripheralId: 'trainer',
        serviceUuid: '00000001-19ca-4651-86e5-fa29dcdd09d1',
        characteristicUuid: '00000003-19ca-4651-86e5-fa29dcdd09d1',
        data: [0x52, 0x69],
        withResponse: false,
      },
    ]);
  });
});
