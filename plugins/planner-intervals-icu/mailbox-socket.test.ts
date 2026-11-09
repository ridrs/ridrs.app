// SPDX-License-Identifier: AGPL-3.0-or-later

import type { WebSocketClient, WebSocketListener } from '@ridrs/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMailboxSocket, socketConfig } from './mailbox-socket.ts';

function harness(gone = true) {
  const opened: Array<{ url: string; listener: WebSocketListener; sent: string[]; closed: boolean }> = [];
  const events: unknown[] = [];
  let catchUps = 0;
  let invalid = 0;
  const socket: WebSocketClient = {
    connect: async (url, listener) => {
      const entry = { url, listener, sent: [] as string[], closed: false };
      opened.push(entry);
      return {
        send: async (text) => {
          entry.sent.push(text);
        },
        close: async () => {
          entry.closed = true;
        },
      };
    },
  };
  const controller = createMailboxSocket({
    socket,
    url: async () => 'wss://ridrs.app/updates/ws?device=d',
    onEvent: async (event) => {
      events.push(event);
    },
    catchUp: async () => {
      catchUps += 1;
    },
    onInvalid: async () => {
      invalid += 1;
      return gone;
    },
    logger: { warn: () => undefined },
    random: () => 0.5,
  });
  return { controller, opened, events, catchUps: () => catchUps, invalid: () => invalid };
}

describe('the mailbox socket', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.assign(socketConfig, { reconnectBaseMs: 1000, reconnectMaxMs: 60_000, pingMs: 30_000, stableMs: 60_000 });
  });
  afterEach(() => vi.useRealTimers());

  it('opens the socket, then catches up, and passes pushed events on', async () => {
    const h = harness();
    h.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.opened).toHaveLength(1);
    expect(h.catchUps()).toBe(1);
    h.opened[0]?.listener.message(JSON.stringify({ t: 'hello', next: 3 }));
    h.opened[0]?.listener.message('pong');
    h.opened[0]?.listener.message(JSON.stringify({ t: 'event', event: { cursor: 4 } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.events).toEqual([{ cursor: 4 }]);
  });

  it('pings every 30 seconds and acknowledges over the socket', async () => {
    const h = harness();
    h.controller.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.opened[0]?.sent).toEqual(['ping']);
    expect(h.controller.ack(7)).toBe(true);
    expect(h.opened[0]?.sent.at(-1)).toBe('{"t":"ack","upto":7}');
  });

  it('reconnects with a doubling delay, catches up again, and starts over after a stable minute', async () => {
    const h = harness();
    h.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    h.opened[0]?.listener.close(1006);
    await vi.advanceTimersByTimeAsync(999);
    expect(h.opened).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.opened).toHaveLength(2);
    expect(h.catchUps()).toBe(2);
    h.opened[1]?.listener.close(1006);
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.opened).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(61_000);
    h.opened[2]?.listener.close(1006);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.opened).toHaveLength(4);
  });

  it('does not reconnect after code 4000, and forgets the registration on 4401', async () => {
    const replaced = harness();
    replaced.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    replaced.opened[0]?.listener.close(4000);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(replaced.opened).toHaveLength(1);
    const invalid = harness(true);
    invalid.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    invalid.opened[0]?.listener.close(4401);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(invalid.opened).toHaveLength(1);
    expect(invalid.invalid()).toBe(1);
  });

  it('backs off and connects again when the relay still knows the device after a 4401', async () => {
    const h = harness(false);
    h.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    h.opened[0]?.listener.close(4401);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.invalid()).toBe(1);
    expect(h.opened).toHaveLength(2);
  });

  it('closes on stop and does not come back', async () => {
    const h = harness();
    h.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    h.controller.stop();
    expect(h.opened[0]?.closed).toBe(true);
    h.opened[0]?.listener.close(1006);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.opened).toHaveLength(1);
    expect(h.controller.ack(1)).toBe(false);
  });
});
