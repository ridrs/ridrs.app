// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type BleCentral,
  type BleCharacteristicTarget,
  type BleConnection,
  type BleDiscoveredPeripheral,
  type BleScanOptions,
  type Clock,
  FTMS_SERVICE_UUID,
  HEART_RATE_MEASUREMENT_CHARACTERISTIC_UUID,
  HEART_RATE_SERVICE_UUID,
  INDOOR_BIKE_DATA_CHARACTERISTIC_UUID,
  normalizeBleUuid,
} from '@ridrs/contracts';

export interface SimulatedPeripheralOptions {
  readonly peripheralId?: string;
  readonly name: string;
  readonly serviceUuids: readonly string[];
  readonly poweredOn?: boolean;
  readonly acceptingConnections?: boolean;
}

function characteristicKey(serviceUuid: string, characteristicUuid: string): string {
  return `${normalizeBleUuid(serviceUuid)}:${normalizeBleUuid(characteristicUuid)}`;
}

function toBytes(bytesOrHex: Uint8Array | string): Uint8Array {
  return typeof bytesOrHex === 'string'
    ? new Uint8Array(Buffer.from(bytesOrHex.replace(/\s+/g, ''), 'hex'))
    : bytesOrHex;
}

function slugifyName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'peripheral'
  );
}

export class SimulatedPeripheral {
  readonly peripheralId: string;
  readonly name: string;
  readonly serviceUuids: readonly string[];
  private poweredOn: boolean;
  private acceptingConnections: boolean;
  private connected = false;
  private everConnected = false;
  private readonly disconnectListeners = new Set<() => void>();
  private readonly connectedListeners = new Set<() => void>();
  private readonly notificationListeners = new Map<string, Set<(data: Uint8Array) => void>>();
  private readonly connectAttemptTimes: number[] = [];
  private lastDisconnectTime?: number;
  private readonly reconnectAttemptTimes: number[] = [];
  private readonly clock: Clock;
  private readonly onBroadcastChanged: (peripheral: SimulatedPeripheral) => void;

  constructor(
    options: SimulatedPeripheralOptions,
    clock: Clock,
    onBroadcastChanged: (peripheral: SimulatedPeripheral) => void,
  ) {
    this.name = options.name;
    this.peripheralId = options.peripheralId ?? `sim-${slugifyName(options.name)}`;
    this.serviceUuids = options.serviceUuids.map(normalizeBleUuid);
    this.poweredOn = options.poweredOn ?? true;
    this.acceptingConnections = options.acceptingConnections ?? true;
    this.clock = clock;
    this.onBroadcastChanged = onBroadcastChanged;
  }

  toDiscoveredPeripheral(): BleDiscoveredPeripheral {
    return {
      peripheralId: this.peripheralId,
      name: this.name,
      serviceUuids: [...this.serviceUuids],
    };
  }

  isPoweredOn(): boolean {
    return this.poweredOn;
  }

  isAcceptingConnections(): boolean {
    return this.acceptingConnections;
  }

  isConnected(): boolean {
    return this.connected;
  }

  wasEverConnected(): boolean {
    return this.everConnected;
  }

  isSubscribed(serviceUuid: string, characteristicUuid: string): boolean {
    const key = characteristicKey(serviceUuid, characteristicUuid);
    const listeners = this.notificationListeners.get(key);
    return Boolean(this.connected && listeners && listeners.size > 0);
  }

  isSubscribedToIndoorBikeData(): boolean {
    return this.isSubscribed(FTMS_SERVICE_UUID, INDOOR_BIKE_DATA_CHARACTERISTIC_UUID);
  }

  switchOff(): void {
    this.poweredOn = false;
    this.acceptingConnections = false;
    if (this.connected) {
      this.dropConnection();
    }
  }

  switchOn(): void {
    this.poweredOn = true;
    this.acceptingConnections = true;
    this.onBroadcastChanged(this);
  }

  dropConnection(): void {
    if (!this.connected) {
      return;
    }
    this.connected = false;
    this.lastDisconnectTime = this.clock.now();
    this.reconnectAttemptTimes.length = 0;
    this.notificationListeners.clear();
    const listeners = [...this.disconnectListeners];
    this.disconnectListeners.clear();
    for (const listener of listeners) {
      listener();
    }
  }

  dropConnectionAndRefuseNew(): void {
    this.acceptingConnections = false;
    this.dropConnection();
  }

  refuseConnections(): void {
    this.acceptingConnections = false;
  }

  acceptConnections(): void {
    this.poweredOn = true;
    this.acceptingConnections = true;
    this.onBroadcastChanged(this);
  }

  notify(serviceUuid: string, characteristicUuid: string, data: Uint8Array): void {
    if (!this.connected) {
      return;
    }
    const key = characteristicKey(serviceUuid, characteristicUuid);
    const listeners = this.notificationListeners.get(key);
    if (!listeners) {
      return;
    }
    for (const listener of [...listeners]) {
      listener(data);
    }
  }

  notifyIndoorBikeData(bytesOrHex: Uint8Array | string): void {
    this.notify(FTMS_SERVICE_UUID, INDOOR_BIKE_DATA_CHARACTERISTIC_UUID, toBytes(bytesOrHex));
  }

  notifyHeartRateMeasurement(bytesOrHex: Uint8Array | string): void {
    this.notify(
      HEART_RATE_SERVICE_UUID,
      HEART_RATE_MEASUREMENT_CHARACTERISTIC_UUID,
      toBytes(bytesOrHex),
    );
  }

  /** Registers a callback for every connection the central establishes with this peripheral. */
  onCentralConnected(listener: () => void): () => void {
    this.connectedListeners.add(listener);
    return () => {
      this.connectedListeners.delete(listener);
    };
  }

  getConnectAttemptTimes(): readonly number[] {
    return [...this.connectAttemptTimes];
  }

  getReconnectAttemptTimes(): readonly number[] {
    return [...this.reconnectAttemptTimes];
  }

  getReconnectWaitDurationsSeconds(): readonly number[] {
    if (this.lastDisconnectTime === undefined) {
      return [];
    }
    const waits: number[] = [];
    let prev = this.lastDisconnectTime;
    for (const attemptTime of this.reconnectAttemptTimes) {
      waits.push(Math.round((attemptTime - prev) / 1000));
      prev = attemptTime;
    }
    return waits;
  }

  /** @internal */
  acceptConnectionFromCentral(signal?: AbortSignal): Promise<BleConnection> {
    const now = this.clock.now();
    this.connectAttemptTimes.push(now);
    if (this.lastDisconnectTime !== undefined && !this.connected) {
      this.reconnectAttemptTimes.push(now);
    }

    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new Error('Connection aborted'));
    }

    if (!this.poweredOn || !this.acceptingConnections) {
      return Promise.reject(
        new Error(`Peripheral "${this.name}" (${this.peripheralId}) refused connection`),
      );
    }

    this.connected = true;
    this.everConnected = true;

    const connection: BleConnection = {
      peripheralId: this.peripheralId,
      subscribe: async (
        characteristic: BleCharacteristicTarget,
        onNotification: (data: Uint8Array) => void,
      ): Promise<() => void> => {
        if (!this.connected) {
          throw new Error(`Peripheral "${this.name}" is disconnected`);
        }
        const key = characteristicKey(
          characteristic.serviceUuid,
          characteristic.characteristicUuid,
        );
        let set = this.notificationListeners.get(key);
        if (!set) {
          set = new Set();
          this.notificationListeners.set(key, set);
        }
        set.add(onNotification);
        return () => {
          set?.delete(onNotification);
        };
      },
      onDisconnected: (listener: () => void): (() => void) => {
        this.disconnectListeners.add(listener);
        return () => {
          this.disconnectListeners.delete(listener);
        };
      },
      disconnect: async (): Promise<void> => {
        if (!this.connected) {
          return;
        }
        this.connected = false;
        this.notificationListeners.clear();
        this.disconnectListeners.clear();
      },
    };

    for (const listener of [...this.connectedListeners]) {
      listener();
    }
    return Promise.resolve(connection);
  }
}

interface ActiveScanSession {
  readonly requestedServices: ReadonlySet<string>;
  readonly queue: BleDiscoveredPeripheral[];
  wakeUp?: () => void;
  stopped: boolean;
}

export class BleSimulator implements BleCentral {
  private readonly clock: Clock;
  private readonly peripheralsById = new Map<string, SimulatedPeripheral>();
  private readonly peripheralsByName = new Map<string, SimulatedPeripheral>();
  private readonly activeScans = new Set<ActiveScanSession>();
  private readonly scanStartListeners = new Set<(signal?: AbortSignal) => void>();

  constructor(options?: { readonly clock?: Clock }) {
    this.clock = options?.clock ?? { now: () => Date.now() };
  }

  addPeripheral(options: SimulatedPeripheralOptions): SimulatedPeripheral {
    const peripheral = new SimulatedPeripheral(options, this.clock, (updated) => {
      this.broadcastPeripheralToScans(updated);
    });
    this.peripheralsById.set(peripheral.peripheralId, peripheral);
    this.peripheralsByName.set(peripheral.name, peripheral);
    if (peripheral.isPoweredOn()) {
      this.broadcastPeripheralToScans(peripheral);
    }
    return peripheral;
  }

  addFtmsTrainer(
    name: string,
    options?: {
      readonly peripheralId?: string;
      readonly poweredOn?: boolean;
      readonly acceptingConnections?: boolean;
    },
  ): SimulatedPeripheral {
    return this.addPeripheral({
      peripheralId: options?.peripheralId,
      name,
      serviceUuids: [FTMS_SERVICE_UUID],
      poweredOn: options?.poweredOn ?? true,
      acceptingConnections: options?.acceptingConnections ?? true,
    });
  }

  addHeartRateSensor(
    name: string,
    options?: { readonly peripheralId?: string },
  ): SimulatedPeripheral {
    return this.addPeripheral({
      peripheralId: options?.peripheralId,
      name,
      serviceUuids: [HEART_RATE_SERVICE_UUID],
    });
  }

  /**
   * The peripheral vanishes: an open connection drops, scans and connects no longer find it.
   * Lookups by name still return it, so a test can talk about the device it just removed.
   */
  removePeripheral(peripheralId: string): void {
    const peripheral = this.peripheralsById.get(peripheralId);
    if (!peripheral) {
      return;
    }
    peripheral.switchOff();
    this.peripheralsById.delete(peripheralId);
  }

  peripherals(): readonly SimulatedPeripheral[] {
    return [...this.peripheralsById.values()];
  }

  /** Total connection attempts the central made against all peripherals. */
  connectAttemptCount(): number {
    let total = 0;
    for (const peripheral of this.peripheralsById.values()) {
      total += peripheral.getConnectAttemptTimes().length;
    }
    return total;
  }

  getPeripheralByName(name: string): SimulatedPeripheral | undefined {
    return this.peripheralsByName.get(name);
  }

  getPeripheralById(peripheralId: string): SimulatedPeripheral | undefined {
    return this.peripheralsById.get(peripheralId);
  }

  hasActiveScan(): boolean {
    return this.activeScans.size > 0;
  }

  onScanStart(listener: (signal?: AbortSignal) => void): () => void {
    this.scanStartListeners.add(listener);
    return () => {
      this.scanStartListeners.delete(listener);
    };
  }

  scan(options: BleScanOptions): AsyncIterable<BleDiscoveredPeripheral> {
    const requestedServices = new Set(options.serviceUuids.map(normalizeBleUuid));
    const signal = options.signal;

    const session: ActiveScanSession = {
      requestedServices,
      queue: [],
      stopped: false,
    };

    const stopSession = (): void => {
      if (session.stopped) {
        return;
      }
      session.stopped = true;
      this.activeScans.delete(session);
      const wake = session.wakeUp;
      session.wakeUp = undefined;
      wake?.();
    };

    if (signal?.aborted) {
      session.stopped = true;
    } else {
      this.activeScans.add(session);
      signal?.addEventListener('abort', stopSession, { once: true });
      for (const peripheral of this.peripheralsById.values()) {
        if (peripheral.isPoweredOn() && this.matchesServices(peripheral, requestedServices)) {
          session.queue.push(peripheral.toDiscoveredPeripheral());
        }
      }
      for (const listener of [...this.scanStartListeners]) {
        listener(signal);
      }
    }

    return {
      [Symbol.asyncIterator]: (): AsyncIterator<BleDiscoveredPeripheral> => {
        return {
          next: async (): Promise<IteratorResult<BleDiscoveredPeripheral>> => {
            while (!session.stopped) {
              const nextItem = session.queue.shift();
              if (nextItem) {
                return { value: nextItem, done: false };
              }
              await new Promise<void>((resolve) => {
                session.wakeUp = resolve;
              });
            }
            return { value: undefined, done: true };
          },
          return: async (): Promise<IteratorResult<BleDiscoveredPeripheral>> => {
            stopSession();
            signal?.removeEventListener('abort', stopSession);
            return { value: undefined, done: true };
          },
        };
      },
    };
  }

  async connect(
    peripheralId: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<BleConnection> {
    const peripheral = this.peripheralsById.get(peripheralId);
    if (!peripheral) {
      throw new Error(`Unknown BLE peripheral "${peripheralId}"`);
    }
    return peripheral.acceptConnectionFromCentral(options?.signal);
  }

  private matchesServices(
    peripheral: SimulatedPeripheral,
    requestedServices: ReadonlySet<string>,
  ): boolean {
    if (requestedServices.size === 0) {
      return true;
    }
    return peripheral.serviceUuids.some((uuid) => requestedServices.has(uuid));
  }

  private broadcastPeripheralToScans(peripheral: SimulatedPeripheral): void {
    if (!peripheral.isPoweredOn()) {
      return;
    }
    for (const session of this.activeScans) {
      if (!session.stopped && this.matchesServices(peripheral, session.requestedServices)) {
        session.queue.push(peripheral.toDiscoveredPeripheral());
        const wake = session.wakeUp;
        session.wakeUp = undefined;
        wake?.();
      }
    }
  }
}
