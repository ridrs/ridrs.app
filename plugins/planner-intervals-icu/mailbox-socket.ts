// SPDX-License-Identifier: AGPL-3.0-or-later

import type { PluginLogger, WebSocketClient, WebSocketConnection } from '@ridrs/contracts';

/**
 * The socket of the mailbox (ADR 0079): a fast path beside the mailbox, which stays the source of
 * truth. On every (re)connect the socket opens first, then `catchUp` fetches what is waiting; an
 * event pushed meanwhile is de-duplicated by the caller (by cursor). Nothing replays on connect.
 * It runs only between `start` and `stop`: while the app runs and the account is connected.
 */

/** Delays in ms; scenarios and tests shorten them. */
export const socketConfig = { reconnectBaseMs: 1000, reconnectMaxMs: 60_000, pingMs: 30_000, stableMs: 60_000 };

/** The peer replaced this connection with a newer one of the same device: do not reconnect. */
const REPLACED = 4000;
/** The relay refused the registration (as does an HTTP 401 before the upgrade): it is checked, not believed. */
const INVALID = 4401;

export interface SocketDeps {
  readonly socket: WebSocketClient;
  /** The signed URL of a connection, or none when the device is not registered. */
  readonly url: () => Promise<string | undefined>;
  /** An event pushed over the socket (`event` of a `{ t: 'event' }` message). */
  readonly onEvent: (event: unknown) => Promise<void>;
  /** Fetches what the mailbox holds, after the socket is open. */
  readonly catchUp: () => Promise<void>;
  /** The relay refused the socket with 401 or 4401: true when it no longer knows the device (keys dropped). */
  readonly onInvalid: () => Promise<boolean>;
  readonly logger: Pick<PluginLogger, 'warn'>;
  readonly random?: () => number;
}

export interface MailboxSocket {
  start(): void;
  stop(): void;
  /** Acknowledges over the open socket; false when there is none (the caller posts instead). */
  ack(upto: number): boolean;
  /** Whether a connection is open now. */
  readonly open: boolean;
}

export function createMailboxSocket(deps: SocketDeps): MailboxSocket {
  const random = deps.random ?? Math.random;
  let running = false;
  let connection: WebSocketConnection | undefined;
  let attempts = 0;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let ping: ReturnType<typeof setInterval> | undefined;
  let openedAt = 0;
  /** Bumped by every connect and stop: a late callback of an old connection does nothing. */
  let generation = 0;

  const clear = () => {
    clearTimeout(reconnect);
    clearInterval(ping);
    reconnect = undefined;
    ping = undefined;
  };

  const retry = () => {
    if (!running) {
      return;
    }
    // 1 s, 2 s, 4 s … up to a minute, with jitter; a connection that held for a minute starts again at 1 s.
    const delay = Math.min(socketConfig.reconnectMaxMs, socketConfig.reconnectBaseMs * 2 ** attempts);
    attempts += 1;
    reconnect = setTimeout(() => void connect(), delay * (0.8 + random() * 0.4));
  };

  const connect = async (): Promise<void> => {
    if (!running) {
      return;
    }
    const mine = ++generation;
    const url = await deps.url().catch(() => undefined);
    if (!url) {
      running = false;
      return;
    }
    try {
      const opened = await deps.socket.connect(url, {
        message: (text) => {
          if (mine === generation) {
            void handle(text);
          }
        },
        close: (code) => {
          if (mine !== generation) {
            return;
          }
          connection = undefined;
          clear();
          if (code === REPLACED) {
            running = false;
          } else if (code === INVALID) {
            void refused(mine);
          } else {
            if (Date.now() - openedAt >= socketConfig.stableMs) {
              attempts = 0;
            }
            retry();
          }
        },
      });
      if (mine !== generation || !running) {
        void opened.close().catch(() => undefined);
        return;
      }
      connection = opened;
      openedAt = Date.now();
      ping = setInterval(() => void opened.send('ping').catch(() => undefined), socketConfig.pingMs);
      // The socket is open: what happened before it is fetched now.
      await deps.catchUp().catch((error: unknown) => deps.logger.warn({ error }, 'mailbox: catch-up failed'));
    } catch (error) {
      if (mine !== generation) {
        return;
      }
      if (String(error).includes('401')) {
        await refused(mine);
        return;
      }
      retry();
    }
  };

  /** A 401 says nothing of why: only a relay that does not know the device ends the socket; else back off. */
  const refused = async (mine: number): Promise<void> => {
    const gone = await deps.onInvalid().catch(() => false);
    if (mine !== generation) {
      return;
    }
    if (gone) {
      running = false;
    } else {
      retry();
    }
  };

  const handle = async (text: string): Promise<void> => {
    if (text === 'pong') {
      return;
    }
    try {
      const message = JSON.parse(text) as { t?: unknown; event?: unknown };
      if (message.t === 'event') {
        await deps.onEvent(message.event);
      }
    } catch (error) {
      deps.logger.warn({ error }, 'mailbox: a socket message was dropped');
    }
  };

  return {
    start() {
      if (running) {
        return;
      }
      running = true;
      attempts = 0;
      void connect();
    },
    stop() {
      running = false;
      generation += 1;
      clear();
      const closing = connection;
      connection = undefined;
      void closing?.close().catch(() => undefined);
    },
    ack(upto) {
      if (!connection) {
        return false;
      }
      void connection.send(JSON.stringify({ t: 'ack', upto })).catch(() => undefined);
      return true;
    },
    get open() {
      return connection !== undefined;
    },
  };
}
