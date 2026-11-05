// SPDX-License-Identifier: AGPL-3.0-or-later

import type { BridgeMessage, BridgeSocket } from '@ridrs/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { BridgeSession } from './session.ts';

/** A companion that welcomes with `protocol` and answers `connect`; it records what it got. */
function companionSpeaking(protocol: string) {
  const sent: BridgeMessage[] = [];
  const listeners = new Set<(message: string | Uint8Array) => void>();
  const reply = (message: BridgeMessage) => {
    for (const listener of listeners) {
      listener(JSON.stringify(message));
    }
  };
  const socket: BridgeSocket = {
    send: (raw) => {
      const message = JSON.parse(String(raw)) as BridgeMessage;
      sent.push(message);
      if (message.type === 'hello') {
        queueMicrotask(() =>
          reply({
            type: 'welcome',
            protocol,
            companionId: 'c',
            companionName: 'Pixel',
            token: 't',
          }),
        );
      } else if (message.type === 'connect') {
        queueMicrotask(() =>
          reply({ type: 'connected', requestId: message.requestId, peripheralId: 'kickr' }),
        );
      }
    },
    onMessage: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onClose: () => () => undefined,
    close: () => undefined,
  };
  return { socket, sent };
}

const CONTROL_POINT = { serviceUuid: '1826', characteristicUuid: '2ad9' };

describe('a companion of an older protocol (ADR 0052)', () => {
  let session: BridgeSession | undefined;

  afterEach(() => {
    session?.close();
    session = undefined;
  });

  it('gets no write with response or read from ridrs: the caller hears why', async () => {
    const companion = companionSpeaking('1.2.0');
    session = await BridgeSession.open(companion.socket, {
      clock: { now: () => 0 },
      clientName: 'ridrs',
      token: 't',
    });
    const connection = await session.connect('kickr');

    await expect(
      connection.write(CONTROL_POINT, new Uint8Array([0]), { withResponse: true }),
    ).rejects.toThrow(/protocol 1\.2\.0: a write with response needs 1\.3\.0/);
    await expect(
      connection.read({ serviceUuid: '1826', characteristicUuid: '2acc' }),
    ).rejects.toThrow(/a read needs 1\.3\.0/);
    expect(companion.sent.map((m) => m.type)).toEqual(['hello', 'connect']);
  });

  it('still gets writes without response', async () => {
    const companion = companionSpeaking('1.2.0');
    session = await BridgeSession.open(companion.socket, {
      clock: { now: () => 0 },
      clientName: 'ridrs',
      token: 't',
    });
    const connection = await session.connect('kickr');
    void connection.write(CONTROL_POINT, new Uint8Array([0x52]));
    await Promise.resolve();
    const write = companion.sent.find((m) => m.type === 'write');
    expect(write).toMatchObject({ type: 'write', data: '52' });
    expect(write && 'withResponse' in write).toBe(false);
  });
});
