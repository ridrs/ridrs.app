// SPDX-License-Identifier: AGPL-3.0-or-later

import type { BridgeSocket } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import { FakeIpc } from '../../../packages/ble-tauri/src/testing/fake-ipc.ts';
import { type CompanionIpc, serveOverIpc } from './ipc-server.ts';

class FakeCompanionIpc extends FakeIpc implements CompanionIpc {}

function event(tag: number, socketId: number, body: string | number[]): ArrayBuffer {
  const bytes = typeof body === 'string' ? [...new TextEncoder().encode(body)] : body;
  const out = new Uint8Array(5 + bytes.length);
  out[0] = tag;
  new DataView(out.buffer).setUint32(1, socketId, true);
  out.set(bytes, 5);
  return out.buffer;
}

describe('serveOverIpc', () => {
  it('announces the companion and turns Rust socket events into BridgeSockets', async () => {
    const ipc = new FakeCompanionIpc();
    ipc.on('bridge_serve', () => ({ port: 4100, addresses: ['10.0.2.16'] }));
    const accepted: Array<{ socket: BridgeSocket; peer: string }> = [];
    const served = await serveOverIpc(
      ipc,
      { name: 'Pixel 8', companionId: 'c1', protocol: '1.0.0', port: 42229 },
      (socket, peer) => accepted.push({ socket, peer }),
    );
    expect(served.info).toEqual({ port: 4100, addresses: ['10.0.2.16'] });
    expect(ipc.callsOf('bridge_serve')[0]?.args).toMatchObject({
      name: 'Pixel 8',
      companionId: 'c1',
    });

    const channel = ipc.channel<ArrayBuffer>('bridge_serve', 'onEvent');
    channel.onmessage(event(0, 9, '192.168.1.20:5123'));
    const { socket, peer } = accepted[0] ?? {};
    expect(peer).toBe('192.168.1.20:5123');
    const got: Array<string | number[]> = [];
    const closes: string[] = [];
    socket?.onMessage((m) => got.push(typeof m === 'string' ? m : [...m]));
    socket?.onClose((r) => closes.push(r));

    channel.onmessage(event(1, 9, '{"type":"ping","sentAt":1}'));
    socket?.send('{"type":"pong"}');
    socket?.send(Uint8Array.of(1, 2, 3));
    channel.onmessage(event(3, 9, 'closed by ridrs'));
    socket?.send('after close');

    expect(got).toEqual(['{"type":"ping","sentAt":1}']);
    expect(ipc.callsOf('bridge_server_send_text').map((c) => c.args)).toEqual([
      { socketId: 9, text: '{"type":"pong"}' },
    ]);
    expect(ipc.callsOf('bridge_server_send_binary').map((c) => c.args)).toEqual([
      { socketId: 9, data: [1, 2, 3] },
    ]);
    expect(closes).toEqual(['closed by ridrs']);
  });
});
