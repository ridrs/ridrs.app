// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  BLE_BRIDGE_PROTOCOL_VERSION,
  type BleCentral,
  type BleCharacteristicTarget,
  type BleConnection,
  type BleDiscoveredPeripheral,
  type BleScanOptions,
  type BridgeMessage,
  type BridgeRejectReason,
  type BridgeSocket,
  type Clock,
  decodeBridgeFrame,
  normalizeBleUuid,
} from '@ridrs/contracts';
import { Liveness, parseMessage, sendMessage } from './link.ts';

export class BridgeRejectedError extends Error {
  override readonly name = 'BridgeRejectedError';
  constructor(
    readonly reason: BridgeRejectReason,
    /** With `paused`: who disconnected deliberately. */
    readonly pausedBy?: 'ridrs' | 'companion',
  ) {
    super(`The companion rejected the connection: ${reason}${pausedBy ? ` by ${pausedBy}` : ''}`);
  }
}

/** The companion answered `hello` with a goodbye, e.g. after `intent: 'forget'`. */
export class BridgeGoodbyeError extends Error {
  override readonly name = 'BridgeGoodbyeError';
  constructor(readonly reason: 'disconnect' | 'forget') {
    super(`The companion said goodbye: ${reason}`);
  }
}

export interface BridgeSessionOptions {
  readonly clock: Clock;
  readonly clientName: string;
  readonly pairingCode?: string;
  /** Secret of the pairing QR code ridrs shows. */
  readonly pairingSecret?: string;
  readonly token?: string;
  /** With a token: automatic `reconnect` (default), rider's `resume`, or `forget`. */
  readonly intent?: 'reconnect' | 'resume' | 'forget';
  /** Only for tests of version negotiation. */
  readonly protocol?: string;
}

type Welcome = Extract<BridgeMessage, { type: 'welcome' }>;
type Reply = Extract<BridgeMessage, { requestId: number }>;

function abortError(): Error {
  return new DOMException('The operation was aborted', 'AbortError');
}

class RemoteConnection implements BleConnection {
  private readonly listeners = new Set<() => void>();
  private ended = false;

  constructor(
    readonly peripheralId: string,
    private readonly session: BridgeSession,
  ) {}

  subscribe(
    target: BleCharacteristicTarget,
    onNotification: (data: Uint8Array) => void,
  ): Promise<() => void> {
    return this.session.subscribe(this.peripheralId, target, onNotification);
  }

  onDisconnected(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async disconnect(): Promise<void> {
    this.ended = true;
    await this.session.disconnect(this.peripheralId);
  }

  /** The link to the peripheral is gone (on the companion, or the bridge itself): at most once. */
  lost(): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

interface ScanState {
  readonly queue: BleDiscoveredPeripheral[];
  wake?: () => void;
  done: boolean;
}

/**
 * The ridrs side of one bridge connection: a `BleCentral` whose calls become protocol messages.
 * When the socket closes, every open connection reports `onDisconnected` and scans end.
 */
export class BridgeSession implements BleCentral {
  private readonly pending = new Map<
    number,
    { resolve: (reply: Reply) => void; reject: (error: Error) => void }
  >();
  private readonly scans = new Map<number, ScanState>();
  private readonly connections = new Map<string, RemoteConnection>();
  private readonly notificationHandlers = new Map<number, (data: Uint8Array) => void>();
  private readonly closeListeners = new Set<(reason: string) => void>();
  private nextRequestId = 1;
  private closedReason?: string;
  /** Set when the companion ended the session deliberately (`bye`) rather than losing it. */
  byeReason?: 'disconnect' | 'forget';
  private liveness?: Liveness;

  private constructor(
    private readonly socket: BridgeSocket,
    private readonly clock: Clock,
    readonly welcome: Welcome,
  ) {}

  /** Sends `hello` and resolves once the companion welcomes us; rejects with `BridgeRejectedError`. */
  static open(socket: BridgeSocket, options: BridgeSessionOptions): Promise<BridgeSession> {
    return new Promise((resolve, reject) => {
      let session: BridgeSession | undefined;
      const stopMessages = socket.onMessage((raw) => {
        if (session) {
          session.receive(raw);
          return;
        }
        if (typeof raw !== 'string') {
          return;
        }
        const message = parseMessage(raw);
        if (message?.type === 'welcome') {
          session = new BridgeSession(socket, options.clock, message);
          session.startHeartbeat();
          resolve(session);
        } else if (message?.type === 'rejected') {
          socket.close();
          reject(new BridgeRejectedError(message.reason, message.pausedBy));
        } else if (message?.type === 'bye') {
          socket.close();
          reject(new BridgeGoodbyeError(message.reason));
        }
      });
      socket.onClose((reason) => {
        stopMessages();
        if (session) {
          session.handleClose(reason);
        } else {
          reject(new Error(`The bridge closed before the handshake: ${reason}`));
        }
      });
      sendMessage(socket, {
        type: 'hello',
        protocol: options.protocol ?? BLE_BRIDGE_PROTOCOL_VERSION,
        clientName: options.clientName,
        ...(options.pairingCode !== undefined ? { pairingCode: options.pairingCode } : {}),
        ...(options.pairingSecret !== undefined ? { pairingSecret: options.pairingSecret } : {}),
        ...(options.token !== undefined ? { token: options.token } : {}),
        ...(options.intent !== undefined ? { intent: options.intent } : {}),
      });
    });
  }

  get closed(): boolean {
    return this.closedReason !== undefined;
  }

  onClose(listener: (reason: string) => void): () => void {
    if (this.closedReason !== undefined) {
      listener(this.closedReason);
      return () => undefined;
    }
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  close(): void {
    this.socket.close();
  }

  /** Ends the session deliberately: the companion learns why before the socket closes. */
  bye(reason: 'disconnect' | 'forget'): void {
    if (!this.closed) {
      sendMessage(this.socket, { type: 'bye', reason });
    }
    this.socket.close();
  }

  async *scan(options: BleScanOptions): AsyncIterable<BleDiscoveredPeripheral> {
    const { signal } = options;
    if (signal?.aborted || this.closed) {
      return;
    }
    const requestId = this.nextRequestId++;
    const state: ScanState = { queue: [], done: false };
    this.scans.set(requestId, state);
    const stop = () => {
      state.done = true;
      state.wake?.();
    };
    signal?.addEventListener('abort', stop, { once: true });
    sendMessage(this.socket, {
      type: 'scan',
      requestId,
      serviceUuids: options.serviceUuids.map(normalizeBleUuid),
    });
    try {
      while (!state.done) {
        const next = state.queue.shift();
        if (next) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          state.wake = resolve;
        });
        state.wake = undefined;
      }
    } finally {
      state.done = true;
      this.scans.delete(requestId);
      signal?.removeEventListener('abort', stop);
      if (!this.closed) {
        sendMessage(this.socket, { type: 'stop-scan', requestId });
      }
    }
  }

  async connect(
    peripheralId: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<BleConnection> {
    if (options.signal?.aborted) {
      throw abortError();
    }
    await this.request({ type: 'connect', requestId: this.nextRequestId++, peripheralId });
    const connection = new RemoteConnection(peripheralId, this);
    this.connections.get(peripheralId)?.lost();
    this.connections.set(peripheralId, connection);
    if (options.signal?.aborted) {
      await connection.disconnect().catch(() => undefined);
      throw abortError();
    }
    return connection;
  }

  /** @internal */
  async subscribe(
    peripheralId: string,
    target: BleCharacteristicTarget,
    onNotification: (data: Uint8Array) => void,
  ): Promise<() => void> {
    const reply = await this.request({
      type: 'subscribe',
      requestId: this.nextRequestId++,
      peripheralId,
      serviceUuid: normalizeBleUuid(target.serviceUuid),
      characteristicUuid: normalizeBleUuid(target.characteristicUuid),
    });
    if (reply.type !== 'subscribed') {
      throw new Error(`Unexpected reply "${reply.type}" to subscribe`);
    }
    const { subscriptionId } = reply;
    this.notificationHandlers.set(subscriptionId, onNotification);
    return () => {
      if (!this.notificationHandlers.delete(subscriptionId) || this.closed) {
        return;
      }
      sendMessage(this.socket, { type: 'unsubscribe', subscriptionId });
    };
  }

  /** @internal */
  async disconnect(peripheralId: string): Promise<void> {
    this.connections.delete(peripheralId);
    if (this.closed) {
      return;
    }
    await this.request({
      type: 'disconnect',
      requestId: this.nextRequestId++,
      peripheralId,
    }).catch(() => undefined);
  }

  private request(message: Extract<BridgeMessage, { requestId: number }>): Promise<Reply> {
    if (this.closed) {
      return Promise.reject(new Error(`The bridge is closed: ${this.closedReason}`));
    }
    return new Promise((resolve, reject) => {
      this.pending.set(message.requestId, {
        resolve: (reply) =>
          reply.type === 'failed' ? reject(new Error(reply.message)) : resolve(reply),
        reject,
      });
      sendMessage(this.socket, message);
    });
  }

  private startHeartbeat(): void {
    this.liveness = new Liveness(
      this.clock,
      () => sendMessage(this.socket, { type: 'ping', sentAt: this.clock.now() }),
      () => this.socket.close(),
    );
  }

  private receive(raw: string | Uint8Array): void {
    this.liveness?.seen();
    if (typeof raw !== 'string') {
      const frame = decodeBridgeFrame(raw);
      // The companion time is diagnostics only: ridrs stamps the receive time with its own clock.
      this.notificationHandlers.get(frame.subscriptionId)?.(frame.data);
      return;
    }
    const message = parseMessage(raw);
    if (!message) {
      return;
    }
    switch (message.type) {
      case 'bye':
        this.byeReason = message.reason;
        return;
      case 'discovered': {
        const scan = this.scans.get(message.requestId);
        if (scan && !scan.done) {
          scan.queue.push({
            peripheralId: message.peripheralId,
            name: message.name,
            serviceUuids: message.serviceUuids.map(normalizeBleUuid),
          });
          scan.wake?.();
        }
        return;
      }
      case 'connection-lost': {
        const connection = this.connections.get(message.peripheralId);
        this.connections.delete(message.peripheralId);
        connection?.lost();
        return;
      }
      case 'connected':
      case 'disconnected':
      case 'subscribed':
      case 'failed': {
        const scan = this.scans.get(message.requestId);
        if (scan && message.type === 'failed') {
          scan.done = true;
          scan.wake?.();
          return;
        }
        const pending = this.pending.get(message.requestId);
        this.pending.delete(message.requestId);
        pending?.resolve(message);
        return;
      }
      default:
        return;
    }
  }

  private handleClose(reason: string): void {
    if (this.closedReason !== undefined) {
      return;
    }
    this.closedReason = reason;
    this.liveness?.stop();
    const error = new Error(`The bridge closed: ${reason}`);
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    for (const scan of this.scans.values()) {
      scan.done = true;
      scan.wake?.();
    }
    this.notificationHandlers.clear();
    const connections = [...this.connections.values()];
    this.connections.clear();
    for (const connection of connections) {
      connection.lost();
    }
    for (const listener of [...this.closeListeners]) {
      listener(reason);
    }
  }
}
