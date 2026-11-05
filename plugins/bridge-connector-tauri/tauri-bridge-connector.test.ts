// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Secrets, StoredBridgePairing } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import { FakeIpc } from '../../packages/ble-tauri/src/testing/fake-ipc.ts';
import {
  PAIRING_SECRET,
  type PairingStore,
  secretPairingStore,
  TauriBridgeConnector,
} from './tauri-bridge-connector.ts';

function memoryStore(): PairingStore {
  let pairing: StoredBridgePairing | undefined;
  return {
    load: () => pairing,
    save: (next) => {
      pairing = next;
    },
    clear: () => {
      pairing = undefined;
    },
  };
}

function event(tag: number, body: string | number[]): ArrayBuffer {
  const bytes = typeof body === 'string' ? [...new TextEncoder().encode(body)] : body;
  return Uint8Array.from([tag, ...bytes]).buffer;
}

describe('TauriBridgeConnector', () => {
  it('turns Rust socket events into text, binary and close callbacks', async () => {
    const ipc = new FakeIpc();
    ipc.on('bridge_open', () => 7);
    const socket = await new TauriBridgeConnector(ipc, memoryStore()).open('10.0.2.2:5000');
    const messages: Array<string | number[]> = [];
    const closes: string[] = [];
    socket.onMessage((m) => messages.push(typeof m === 'string' ? m : [...m]));
    socket.onClose((reason) => closes.push(reason));

    const channel = ipc.channel<ArrayBuffer>('bridge_open', 'onMessage');
    channel.onmessage(event(1, '{"type":"ping","sentAt":1}'));
    channel.onmessage(event(2, [1, 0, 0, 0, 0xab]));
    channel.onmessage(event(3, 'closed by companion'));
    channel.onmessage(event(3, 'again'));

    expect(ipc.callsOf('bridge_open')[0]?.args.address).toBe('10.0.2.2:5000');
    expect(messages).toEqual(['{"type":"ping","sentAt":1}', [1, 0, 0, 0, 0xab]]);
    expect(closes).toEqual(['closed by companion']);
  });

  it('rejects with an Error when the Rust side reports a failure as text', async () => {
    const ipc = new FakeIpc();
    ipc.on('bridge_open', () => Promise.reject('Connection refused (os error 111)'));
    const opening = new TauriBridgeConnector(ipc, memoryStore()).open('10.0.2.2:42229');
    await expect(opening).rejects.toThrow('10.0.2.2:42229: Connection refused (os error 111)');
    await expect(opening).rejects.toBeInstanceOf(Error);
  });

  it('sends text by socket id and closes the Rust socket once', async () => {
    const ipc = new FakeIpc();
    ipc.on('bridge_open', () => 3);
    const socket = await new TauriBridgeConnector(ipc, memoryStore()).open('a:1');
    socket.send('hello');
    socket.close();
    socket.close();
    socket.send('ignored');

    expect(ipc.callsOf('bridge_send_text').map((c) => c.args)).toEqual([
      { socketId: 3, text: 'hello' },
    ]);
    expect(ipc.callsOf('bridge_close')).toHaveLength(1);
  });

  it('reports the companion list as the Rust browser sends it, until stopped', () => {
    const ipc = new FakeIpc();
    const connector = new TauriBridgeConnector(ipc, memoryStore());
    const lists: string[][] = [];
    const stop = connector.watchCompanions((c) => lists.push(c.map((a) => a.name)));
    const channel = ipc.channel<unknown[]>('bridge_browse', 'onEvent');
    channel.onmessage([{ companionId: 'c1', name: 'Pixel 8', address: '192.168.1.5:4000' }]);
    stop();
    channel.onmessage([]);

    expect(lists).toEqual([['Pixel 8']]);
    expect(ipc.callsOf('bridge_stop_browse')).toHaveLength(1);
  });
});

const PAIRING: StoredBridgePairing = {
  companionId: 'c1',
  companionName: 'Pixel 8',
  address: '192.168.1.5:4000',
  token: 't0k3n',
};

function memorySecrets(failing = false): Secrets & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  const check = async () => {
    if (failing) throw new Error('store locked');
  };
  return {
    values,
    get: async (key) => (await check(), values.get(key)),
    set: async (key, value) => {
      await check();
      values.set(key, value);
    },
    remove: async (key) => {
      await check();
      values.delete(key);
    },
  };
}

function legacyStorage(entries: Record<string, string>): Pick<Storage, 'getItem' | 'removeItem'> & {
  readonly entries: Record<string, string>;
} {
  return {
    entries,
    getItem: (key) => entries[key] ?? null,
    removeItem: (key) => {
      delete entries[key];
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const quiet = () => undefined;

describe('secretPairingStore', () => {
  it('keeps the pairing, its token included, in the secret store only', async () => {
    const secrets = memorySecrets();
    const store = await secretPairingStore(secrets, legacyStorage({}), quiet);
    expect(store.load()).toBeUndefined();
    store.save(PAIRING);
    expect(store.load()).toEqual(PAIRING);
    await settle();
    expect(JSON.parse(secrets.values.get(PAIRING_SECRET) ?? '')).toEqual(PAIRING);

    const again = await secretPairingStore(secrets, legacyStorage({}), quiet);
    expect(again.load()).toEqual(PAIRING);
    again.clear();
    await settle();
    expect(again.load()).toBeUndefined();
    expect(secrets.values.has(PAIRING_SECRET)).toBe(false);
  });

  it('moves a pairing out of the WebView storage once', async () => {
    const secrets = memorySecrets();
    const legacy = legacyStorage({ 'ridrs.bridge.pairing': JSON.stringify(PAIRING) });
    const store = await secretPairingStore(secrets, legacy, quiet);
    expect(store.load()).toEqual(PAIRING);
    expect(JSON.parse(secrets.values.get(PAIRING_SECRET) ?? '')).toEqual(PAIRING);
    expect(legacy.entries).toEqual({});
  });

  it('treats damaged data as no pairing', async () => {
    const secrets = memorySecrets();
    secrets.values.set(PAIRING_SECRET, '{"companionId":');
    const legacy = legacyStorage({ 'ridrs.bridge.pairing': '{"token":1}' });
    const store = await secretPairingStore(secrets, legacy, quiet);
    expect(store.load()).toBeUndefined();
    expect(legacy.entries).toEqual({});
  });

  it('starts without a pairing when the store fails, and keeps the old one where it was', async () => {
    const legacy = legacyStorage({ 'ridrs.bridge.pairing': JSON.stringify(PAIRING) });
    const warnings: string[] = [];
    const store = await secretPairingStore(memorySecrets(true), legacy, (message) =>
      warnings.push(message),
    );
    expect(store.load()).toEqual(PAIRING);
    expect(Object.keys(legacy.entries)).toEqual(['ridrs.bridge.pairing']);
    store.save(PAIRING);
    await settle();
    expect(warnings).toEqual([
      'the companion pairing could not be read',
      'the companion pairing could not move to the secret store',
      'the companion pairing could not be saved',
    ]);
  });
});
