// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  BLE_BRIDGE_PROTOCOL_VERSION,
  type BleCentral,
  type BleConnection,
  type BridgeMessage,
  type BridgeSocket,
  encodeBridgeFrame,
  hexToBytes,
  normalizeBleUuid,
  type TimeSource,
} from '@ridrs/contracts';
import semver from 'semver';
import { Liveness, parseMessage, sendMessage } from './link.ts';
import type { PairingAuthority } from './pairing.ts';

export interface BridgeServerOptions {
  /** The BLE central the companion forwards: native Bluetooth, dummy devices, or both. */
  readonly central: BleCentral;
  readonly authority: PairingAuthority;
  readonly clock: TimeSource;
  readonly companionName: string;
}

export interface BridgeServerStatus {
  /** Name of the paired ridrs currently connected, if any. */
  readonly client?: string;
  /** Every paired ridrs and whether it is connected, deliberately disconnected, or awaited. */
  readonly pairings: readonly {
    readonly token: string;
    readonly clientName: string;
    readonly state: 'connected' | 'disconnected' | 'waiting';
    readonly pausedBy?: 'ridrs' | 'companion';
  }[];
  readonly connectedPeripherals: readonly string[];
  readonly subscriptions: number;
  readonly notificationsForwarded: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Signal and advertising data in `discovered` came with 1.2: an older client rejects them. */
function takesAdvertisingData(protocol: string): boolean {
  const theirs = semver.parse(protocol);
  return theirs !== null && semver.gte(theirs, '1.2.0');
}

function isCompatible(protocol: string): boolean {
  const ours = semver.parse(BLE_BRIDGE_PROTOCOL_VERSION);
  const theirs = semver.parse(protocol);
  return ours !== null && theirs !== null && ours.major === theirs.major;
}

/** Everything one paired ridrs holds on the companion; released when its socket goes away. */
class ClientSession {
  readonly scans = new Map<number, AbortController>();
  readonly connections = new Map<string, BleConnection>();
  readonly subscriptions = new Map<number, { peripheralId: string; stop: () => void }>();
  private nextSubscriptionId = 1;
  private closed = false;
  private readonly liveness: Liveness;

  constructor(
    readonly clientName: string,
    readonly token: string,
    /** The protocol the client said in its `hello`. */
    private readonly protocol: string,
    private readonly socket: BridgeSocket,
    private readonly server: BridgeServer,
    private readonly options: BridgeServerOptions,
  ) {
    this.liveness = new Liveness(
      options.clock,
      () => undefined,
      () => socket.close(),
    );
  }

  handle(message: BridgeMessage): void {
    this.liveness.seen();
    switch (message.type) {
      case 'ping':
        sendMessage(this.socket, {
          type: 'pong',
          sentAt: message.sentAt,
          companionTime: this.options.clock.now(),
        });
        return;
      case 'scan':
        this.server.scanRequests += 1;
        void this.scan(message.requestId, message.serviceUuids);
        return;
      case 'stop-scan':
        this.scans.get(message.requestId)?.abort();
        return;
      case 'connect':
        void this.connect(message.requestId, message.peripheralId);
        return;
      case 'disconnect':
        void this.disconnect(message.requestId, message.peripheralId);
        return;
      case 'subscribe':
        void this.subscribe(message);
        return;
      case 'write':
        void this.write(message);
        return;
      case 'bye':
        this.server.byeFromClient(this, message.reason);
        return;
      case 'unsubscribe':
        this.subscriptions.get(message.subscriptionId)?.stop();
        this.subscriptions.delete(message.subscriptionId);
        this.server.changed();
        return;
      default:
        return;
    }
  }

  seen(): void {
    this.liveness.seen();
  }

  /** Tells ridrs why the companion ends the session, then closes it. */
  bye(reason: 'disconnect' | 'forget'): void {
    sendMessage(this.socket, { type: 'bye', reason });
    this.socket.close();
  }

  private async scan(requestId: number, serviceUuids: readonly string[]): Promise<void> {
    const abort = new AbortController();
    this.scans.set(requestId, abort);
    const advertising = takesAdvertisingData(this.protocol);
    try {
      for await (const peripheral of this.options.central.scan({
        serviceUuids,
        signal: abort.signal,
      })) {
        if (this.closed) {
          break;
        }
        sendMessage(this.socket, {
          type: 'discovered',
          requestId,
          peripheralId: peripheral.peripheralId,
          name: peripheral.name,
          serviceUuids: peripheral.serviceUuids.map(normalizeBleUuid),
          ...(advertising && peripheral.rssi !== undefined ? { rssi: peripheral.rssi } : {}),
          ...(advertising && peripheral.manufacturerData
            ? { manufacturerData: { ...peripheral.manufacturerData } }
            : {}),
          ...(advertising && peripheral.serviceData
            ? { serviceData: { ...peripheral.serviceData } }
            : {}),
        });
      }
    } catch (error) {
      if (!this.closed) {
        sendMessage(this.socket, { type: 'failed', requestId, message: errorMessage(error) });
      }
    } finally {
      this.scans.delete(requestId);
    }
  }

  private async connect(requestId: number, peripheralId: string): Promise<void> {
    try {
      const connection =
        this.connections.get(peripheralId) ?? (await this.options.central.connect(peripheralId));
      if (this.closed) {
        await connection.disconnect().catch(() => undefined);
        return;
      }
      if (!this.connections.has(peripheralId)) {
        this.connections.set(peripheralId, connection);
        connection.onDisconnected(() => {
          if (this.connections.get(peripheralId) !== connection) {
            return;
          }
          this.connections.delete(peripheralId);
          this.dropSubscriptionsOf(peripheralId);
          if (!this.closed) {
            sendMessage(this.socket, { type: 'connection-lost', peripheralId });
          }
          this.server.changed();
        });
      }
      sendMessage(this.socket, { type: 'connected', requestId, peripheralId });
      this.server.changed();
    } catch (error) {
      if (!this.closed) {
        sendMessage(this.socket, { type: 'failed', requestId, message: errorMessage(error) });
      }
    }
  }

  private async disconnect(requestId: number, peripheralId: string): Promise<void> {
    const connection = this.connections.get(peripheralId);
    this.connections.delete(peripheralId);
    this.dropSubscriptionsOf(peripheralId);
    await connection?.disconnect().catch(() => undefined);
    if (!this.closed) {
      sendMessage(this.socket, { type: 'disconnected', requestId });
    }
    this.server.changed();
  }

  private async subscribe(message: Extract<BridgeMessage, { type: 'subscribe' }>): Promise<void> {
    const { requestId, peripheralId } = message;
    const connection = this.connections.get(peripheralId);
    if (!connection) {
      sendMessage(this.socket, {
        type: 'failed',
        requestId,
        message: `Peripheral "${peripheralId}" is not connected`,
      });
      return;
    }
    const subscriptionId = this.nextSubscriptionId++;
    try {
      const stop = await connection.subscribe(
        { serviceUuid: message.serviceUuid, characteristicUuid: message.characteristicUuid },
        (data) => {
          if (this.closed || !this.subscriptions.has(subscriptionId)) {
            return;
          }
          this.server.notificationsForwarded += 1;
          this.socket.send(
            encodeBridgeFrame({ subscriptionId, companionTime: this.options.clock.now(), data }),
          );
        },
      );
      if (this.closed) {
        stop();
        return;
      }
      this.subscriptions.set(subscriptionId, { peripheralId, stop });
      sendMessage(this.socket, { type: 'subscribed', requestId, subscriptionId });
      this.server.changed();
    } catch (error) {
      if (!this.closed) {
        sendMessage(this.socket, { type: 'failed', requestId, message: errorMessage(error) });
      }
    }
  }

  private async write(message: Extract<BridgeMessage, { type: 'write' }>): Promise<void> {
    const { requestId, peripheralId } = message;
    const connection = this.connections.get(peripheralId);
    try {
      if (!connection) {
        throw new Error(`Peripheral "${peripheralId}" is not connected`);
      }
      await connection.write(
        { serviceUuid: message.serviceUuid, characteristicUuid: message.characteristicUuid },
        hexToBytes(message.data),
      );
      if (!this.closed) {
        sendMessage(this.socket, { type: 'written', requestId });
      }
    } catch (error) {
      if (!this.closed) {
        sendMessage(this.socket, { type: 'failed', requestId, message: errorMessage(error) });
      }
    }
  }

  private dropSubscriptionsOf(peripheralId: string): void {
    for (const [id, subscription] of this.subscriptions) {
      if (subscription.peripheralId === peripheralId) {
        subscription.stop();
        this.subscriptions.delete(id);
      }
    }
  }

  /** Releases every scan, subscription and Bluetooth connection this client held. */
  async release(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.liveness.stop();
    for (const scan of this.scans.values()) {
      scan.abort();
    }
    this.scans.clear();
    for (const subscription of this.subscriptions.values()) {
      subscription.stop();
    }
    this.subscriptions.clear();
    const connections = [...this.connections.values()];
    this.connections.clear();
    await Promise.all(connections.map((c) => c.disconnect().catch(() => undefined)));
  }
}

/**
 * The companion side: accepts sockets, authenticates one ridrs at a time and forwards raw GATT
 * traffic of its BLE central. It never decodes payloads.
 */
export class BridgeServer {
  /** Scan requests received so far (diagnostics, tests). */
  scanRequests = 0;
  notificationsForwarded = 0;
  private active?: ClientSession;
  private readonly listeners = new Set<(status: BridgeServerStatus) => void>();
  private readonly sockets = new Set<BridgeSocket>();

  constructor(private readonly options: BridgeServerOptions) {}

  accept(socket: BridgeSocket): void {
    this.sockets.add(socket);
    let session: ClientSession | undefined;
    const stopMessages = socket.onMessage((raw) => {
      session?.seen();
      if (typeof raw !== 'string') {
        return;
      }
      const message = parseMessage(raw);
      if (!message) {
        return;
      }
      if (session) {
        session.handle(message);
        return;
      }
      if (message.type !== 'hello') {
        return;
      }
      const result = this.authenticate(message);
      if (result.type !== 'welcome') {
        sendMessage(socket, result);
        socket.close();
        return;
      }
      // The same ridrs again (it lost the link before we noticed): the new session wins.
      if (this.active?.token === result.token) {
        this.active.bye('disconnect');
      }
      session = new ClientSession(
        message.clientName,
        result.token,
        message.protocol,
        socket,
        this,
        this.options,
      );
      this.active = session;
      sendMessage(socket, result);
      this.changed();
    });
    socket.onClose(() => {
      stopMessages();
      this.sockets.delete(socket);
      if (session) {
        const closing = session;
        session = undefined;
        if (this.active === closing) {
          this.active = undefined;
        }
        void closing.release().then(() => this.changed());
      }
    });
  }

  status(): BridgeServerStatus {
    const active = this.active;
    return {
      client: active?.clientName,
      connectedPeripherals: [...(active?.connections.keys() ?? [])],
      subscriptions: active?.subscriptions.size ?? 0,
      notificationsForwarded: this.notificationsForwarded,
      pairings: this.options.authority.list().map((p) => ({
        token: p.token,
        clientName: p.clientName,
        state: active?.token === p.token ? 'connected' : p.pausedBy ? 'disconnected' : 'waiting',
        pausedBy: p.pausedBy,
      })),
    };
  }

  onStatus(listener: (status: BridgeServerStatus) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** The rider pressed Disconnect on the phone: ends the session and refuses auto-reconnects. */
  disconnect(token: string): void {
    this.options.authority.setPaused(token, 'companion');
    if (this.active?.token === token) {
      this.active.bye('disconnect');
    }
    this.changed();
  }

  /** The rider pressed Connect on the phone: ridrs's next automatic attempt is welcome again. */
  connect(token: string): void {
    this.options.authority.setPaused(token, undefined);
    this.changed();
  }

  /** The rider forgot this ridrs on the phone: it has to pair again. */
  forget(token: string): void {
    this.options.authority.forget(token);
    if (this.active?.token === token) {
      this.active.bye('forget');
    }
    this.changed();
  }

  /** Forgets every paired ridrs. */
  forgetAll(): void {
    for (const pairing of [...this.options.authority.list()]) {
      this.forget(pairing.token);
    }
  }

  /** Closes every socket, which releases the active client's Bluetooth resources. */
  close(): void {
    for (const socket of [...this.sockets]) {
      socket.close();
    }
  }

  /** @internal ridrs ended the session deliberately. */
  byeFromClient(session: ClientSession, reason: 'disconnect' | 'forget'): void {
    if (reason === 'forget') {
      this.options.authority.forget(session.token);
    } else {
      this.options.authority.setPaused(session.token, 'ridrs');
    }
    session.bye(reason);
  }

  /** @internal */
  changed(): void {
    const status = this.status();
    for (const listener of [...this.listeners]) {
      listener(status);
    }
  }

  private authenticate(
    hello: Extract<BridgeMessage, { type: 'hello' }>,
  ): Extract<BridgeMessage, { type: 'welcome' | 'rejected' | 'bye' }> {
    const { authority } = this.options;
    if (!isCompatible(hello.protocol)) {
      return { type: 'rejected', reason: 'incompatible' };
    }
    if (hello.token !== undefined) {
      const pairing = authority.find(hello.token);
      if (!pairing) {
        return { type: 'rejected', reason: 'bad-token' };
      }
      if (hello.intent === 'forget') {
        authority.forget(hello.token);
        this.changed();
        return { type: 'bye', reason: 'forget' };
      }
      if (hello.intent === 'resume') {
        authority.setPaused(hello.token, undefined);
      } else if (pairing.pausedBy) {
        return { type: 'rejected', reason: 'paused', pausedBy: pairing.pausedBy };
      }
      if (this.active && this.active.token !== hello.token) {
        return { type: 'rejected', reason: 'busy' };
      }
      return this.welcome(hello.token);
    }
    if (this.active) {
      return { type: 'rejected', reason: 'busy' };
    }
    if (hello.pairingSecret !== undefined) {
      const verdict = authority.verifySecret(hello.pairingSecret);
      if (verdict !== 'ok') {
        return { type: 'rejected', reason: verdict };
      }
    } else {
      const verdict = authority.verifyCode(hello.pairingCode ?? '');
      if (verdict !== 'ok') {
        return { type: 'rejected', reason: verdict };
      }
    }
    return this.welcome(authority.issueToken(hello.clientName));
  }

  private welcome(token: string): Extract<BridgeMessage, { type: 'welcome' }> {
    return {
      type: 'welcome',
      protocol: BLE_BRIDGE_PROTOCOL_VERSION,
      companionId: this.options.authority.companionId,
      companionName: this.options.companionName,
      token,
    };
  }
}
