// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  BATTERY_LEVEL_CHARACTERISTIC_UUID,
  BATTERY_SERVICE_UUID,
  type BleAdvertisedData,
  type BleCentral,
  type BleCharacteristicTarget,
  type BleConnection,
  type BleDiscoveredPeripheral,
  type BleScanOptions,
  type BleWriteOptions,
  FTMS_SERVICE_UUID,
  HEART_RATE_MEASUREMENT_CHARACTERISTIC_UUID,
  HEART_RATE_SERVICE_UUID,
  INDOOR_BIKE_DATA_CHARACTERISTIC_UUID,
  normalizeBleUuid,
  type TimeSource,
  ZWIFT_RIDE_NOTIFY_CHARACTERISTIC_UUID,
  ZWIFT_RIDE_SERVICE_UUID,
} from '@ridrs/contracts';
import { type SimulatedFtmsControlOptions, SimulatedFtmsControlPoint } from './ftms-control.ts';

export interface SimulatedPeripheralOptions {
  readonly peripheralId?: string;
  readonly name: string;
  readonly serviceUuids: readonly string[];
  readonly poweredOn?: boolean;
  readonly acceptingConnections?: boolean;
  /** Signal strength in dBm its advertisements carry; none by default. */
  readonly rssi?: number;
  /** Manufacturer data its advertisements carry (company id → hex); none by default. */
  readonly manufacturerData?: BleAdvertisedData;
  /** Service data its advertisements carry (service → hex); none by default. */
  readonly serviceData?: BleAdvertisedData;
  /**
   * Its advertisements carry no name until `advertiseName()`, like a device whose name only comes
   * with the scan response.
   */
  readonly nameLater?: boolean;
}

/**
 * What a peripheral does with a write to one characteristic: a GATT error rejects the write (and
 * the peripheral never received it), anything else accepts it.
 */
export type SimulatedWriteHandler = (data: Uint8Array) => { readonly error?: string } | undefined;

/** One write a central made, with what it listened to at that moment. */
export interface SimulatedWrite {
  readonly data: Uint8Array;
  /** Whether the central asked for a write response. */
  readonly withResponse: boolean;
  /** `service:characteristic` keys with an active subscription when the write arrived. */
  readonly subscribed: readonly string[];
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
  private rssi: number | undefined;
  private manufacturerData: BleAdvertisedData | undefined;
  private serviceData: BleAdvertisedData | undefined;
  private nameAdvertised: boolean;
  private connected = false;
  private everConnected = false;
  private readonly disconnectListeners = new Set<() => void>();
  private readonly connectedListeners = new Set<() => void>();
  private readonly notificationListeners = new Map<string, Set<(data: Uint8Array) => void>>();
  private readonly writeLog = new Map<string, SimulatedWrite[]>();
  /** Values a central can read, by characteristic. */
  private readonly values = new Map<string, Uint8Array>();
  private readonly writeHandlers = new Map<string, SimulatedWriteHandler>();
  /** The characteristics its GATT table has; undefined: any a central asks for. */
  private characteristics?: Set<string>;
  /** The FTMS control point model, on a trainer that has one. */
  ftmsControl?: SimulatedFtmsControlPoint;
  private readonly connectAttemptTimes: number[] = [];
  private lastDisconnectTime?: number;
  private readonly reconnectAttemptTimes: number[] = [];
  private readonly clock: TimeSource;
  private readonly onBroadcastChanged: (peripheral: SimulatedPeripheral) => void;

  constructor(
    options: SimulatedPeripheralOptions,
    clock: TimeSource,
    onBroadcastChanged: (peripheral: SimulatedPeripheral) => void,
  ) {
    this.name = options.name;
    this.peripheralId = options.peripheralId ?? `sim-${slugifyName(options.name)}`;
    this.serviceUuids = options.serviceUuids.map(normalizeBleUuid);
    this.poweredOn = options.poweredOn ?? true;
    this.acceptingConnections = options.acceptingConnections ?? true;
    this.rssi = options.rssi;
    this.manufacturerData = options.manufacturerData;
    this.serviceData = options.serviceData;
    this.nameAdvertised = !options.nameLater;
    this.clock = clock;
    this.onBroadcastChanged = onBroadcastChanged;
  }

  toDiscoveredPeripheral(): BleDiscoveredPeripheral {
    return {
      peripheralId: this.peripheralId,
      name: this.nameAdvertised ? this.name : '',
      serviceUuids: [...this.serviceUuids],
      ...(this.rssi === undefined ? {} : { rssi: this.rssi }),
      ...(this.manufacturerData ? { manufacturerData: { ...this.manufacturerData } } : {}),
      ...(this.serviceData ? { serviceData: { ...this.serviceData } } : {}),
    };
  }

  /** Its next advertisement carries this data in place of what it advertised so far. */
  advertise(data: {
    readonly manufacturerData?: BleAdvertisedData;
    readonly serviceData?: BleAdvertisedData;
  }): void {
    if (data.manufacturerData) {
      this.manufacturerData = data.manufacturerData;
    }
    if (data.serviceData) {
      this.serviceData = data.serviceData;
    }
    this.onBroadcastChanged(this);
  }

  /** The device is nearer or farther: its next advertisement carries this signal strength. */
  setSignal(rssi: number): void {
    this.rssi = rssi;
    this.onBroadcastChanged(this);
  }

  /** Its next advertisement carries its name. */
  advertiseName(): void {
    this.nameAdvertised = true;
    this.onBroadcastChanged(this);
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

  notifyZwiftRide(bytesOrHex: Uint8Array | string): void {
    this.notify(
      ZWIFT_RIDE_SERVICE_UUID,
      ZWIFT_RIDE_NOTIFY_CHARACTERISTIC_UUID,
      toBytes(bytesOrHex),
    );
  }

  /**
   * Its Battery Service tells this level from now on: a central reads it, and one subscribed is
   * notified. The GATT table gets the Battery Level, when the peripheral has a table.
   */
  setBatteryLevel(percent: number): void {
    this.characteristics?.add(
      characteristicKey(BATTERY_SERVICE_UUID, BATTERY_LEVEL_CHARACTERISTIC_UUID),
    );
    this.setValue(BATTERY_SERVICE_UUID, BATTERY_LEVEL_CHARACTERISTIC_UUID, Uint8Array.of(percent));
    this.notify(BATTERY_SERVICE_UUID, BATTERY_LEVEL_CHARACTERISTIC_UUID, Uint8Array.of(percent));
  }

  /** A value a central can read from the characteristic from now on. */
  setValue(serviceUuid: string, characteristicUuid: string, bytesOrHex: Uint8Array | string): void {
    this.values.set(characteristicKey(serviceUuid, characteristicUuid), toBytes(bytesOrHex));
  }

  /** The peripheral handles every write to the characteristic. */
  onWrite(serviceUuid: string, characteristicUuid: string, handler: SimulatedWriteHandler): void {
    this.writeHandlers.set(characteristicKey(serviceUuid, characteristicUuid), handler);
  }

  /** Its GATT table has exactly these `service:characteristic` pairs from now on. */
  setCharacteristics(targets: readonly BleCharacteristicTarget[]): void {
    this.characteristics = new Set(
      targets.map((t) => characteristicKey(t.serviceUuid, t.characteristicUuid)),
    );
  }

  /** Its GATT table loses the characteristic. */
  removeCharacteristic(serviceUuid: string, characteristicUuid: string): void {
    const key = characteristicKey(serviceUuid, characteristicUuid);
    this.characteristics?.delete(key);
    this.values.delete(key);
    this.writeHandlers.delete(key);
  }

  private assertCharacteristic(key: string): void {
    if (this.characteristics && !this.characteristics.has(key)) {
      throw new Error(`Peripheral "${this.name}" has no characteristic ${key}`);
    }
  }

  /** Every write to this characteristic, over all connections, oldest first. */
  getWrites(serviceUuid: string, characteristicUuid: string): readonly SimulatedWrite[] {
    return [...(this.writeLog.get(characteristicKey(serviceUuid, characteristicUuid)) ?? [])];
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
        this.assertCharacteristic(key);
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
      write: async (
        characteristic: BleCharacteristicTarget,
        data: Uint8Array,
        options?: BleWriteOptions,
      ): Promise<void> => {
        if (!this.connected) {
          throw new Error(`Peripheral "${this.name}" is disconnected`);
        }
        const key = characteristicKey(
          characteristic.serviceUuid,
          characteristic.characteristicUuid,
        );
        this.assertCharacteristic(key);
        const handled = this.writeHandlers.get(key)?.(data.slice());
        if (handled?.error) {
          throw new Error(handled.error);
        }
        const subscribed = [...this.notificationListeners]
          .filter(([, listeners]) => listeners.size > 0)
          .map(([k]) => k);
        const log = this.writeLog.get(key) ?? [];
        log.push({ data: data.slice(), withResponse: options?.withResponse ?? false, subscribed });
        this.writeLog.set(key, log);
      },
      read: async (characteristic: BleCharacteristicTarget): Promise<Uint8Array> => {
        if (!this.connected) {
          throw new Error(`Peripheral "${this.name}" is disconnected`);
        }
        const key = characteristicKey(
          characteristic.serviceUuid,
          characteristic.characteristicUuid,
        );
        this.assertCharacteristic(key);
        const value = this.values.get(key);
        if (!value) {
          throw new Error(`Characteristic ${key} of "${this.name}" is not readable`);
        }
        return value.slice();
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

/** Real devices advertise many times a second; once a second is enough for every scan. */
const ADVERTISING_INTERVAL_MS = 1000;

interface ActiveScanSession {
  readonly requestedServices: ReadonlySet<string>;
  /** Reports every device the scan hears again, like the advertisements of real devices. */
  advertising?: ReturnType<typeof setInterval>;
  readonly queue: BleDiscoveredPeripheral[];
  wakeUp?: () => void;
  stopped: boolean;
  /** Why the scan ended, when it failed: the scan throws it. */
  error?: unknown;
}

export class BleSimulator implements BleCentral {
  private readonly clock: TimeSource;
  private readonly peripheralsById = new Map<string, SimulatedPeripheral>();
  private readonly peripheralsByName = new Map<string, SimulatedPeripheral>();
  private readonly activeScans = new Set<ActiveScanSession>();
  private readonly scanStartListeners = new Set<(signal?: AbortSignal) => void>();

  constructor(options?: { readonly clock?: TimeSource }) {
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

  /**
   * An FTMS trainer: a sensor that sends Indoor Bike Data, and with `control` one that also has a
   * Feature characteristic and a control point (`peripheral.ftmsControl`).
   */
  addFtmsTrainer(
    name: string,
    options?: {
      readonly peripheralId?: string;
      readonly poweredOn?: boolean;
      readonly acceptingConnections?: boolean;
      readonly nameLater?: boolean;
      readonly manufacturerData?: BleAdvertisedData;
      readonly serviceData?: BleAdvertisedData;
      readonly control?: SimulatedFtmsControlOptions;
    },
  ): SimulatedPeripheral {
    const trainer = this.addPeripheral({
      peripheralId: options?.peripheralId,
      name,
      serviceUuids: [FTMS_SERVICE_UUID],
      poweredOn: options?.poweredOn ?? true,
      acceptingConnections: options?.acceptingConnections ?? true,
      nameLater: options?.nameLater,
      manufacturerData: options?.manufacturerData,
      serviceData: options?.serviceData,
    });
    if (options?.control) {
      trainer.ftmsControl = new SimulatedFtmsControlPoint(trainer, options.control);
    }
    return trainer;
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

  /** A Zwift Ride: the left controller advertises and holds the link for the pair. */
  addZwiftRide(name: string, options?: { readonly peripheralId?: string }): SimulatedPeripheral {
    return this.addPeripheral({
      peripheralId: options?.peripheralId,
      name,
      serviceUuids: [ZWIFT_RIDE_SERVICE_UUID],
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
    for (const session of this.activeScans) {
      if (!session.stopped && this.matchesServices(peripheral, session.requestedServices)) {
        session.queue.push({ ...peripheral.toDiscoveredPeripheral(), vanished: true });
        const wake = session.wakeUp;
        session.wakeUp = undefined;
        wake?.();
      }
    }
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

  /** Every running scan fails with `error`, as when Bluetooth is switched off. */
  failScans(error: unknown): void {
    for (const session of [...this.activeScans]) {
      session.error = error;
      session.stopped = true;
      clearInterval(session.advertising);
      this.activeScans.delete(session);
      const wake = session.wakeUp;
      session.wakeUp = undefined;
      wake?.();
    }
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
      clearInterval(session.advertising);
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
      const advertise = (): void => {
        for (const peripheral of this.peripheralsById.values()) {
          if (peripheral.isPoweredOn() && this.matchesServices(peripheral, requestedServices)) {
            session.queue.push(peripheral.toDiscoveredPeripheral());
          }
        }
      };
      advertise();
      session.advertising = setInterval(() => {
        advertise();
        const wake = session.wakeUp;
        session.wakeUp = undefined;
        wake?.();
      }, ADVERTISING_INTERVAL_MS);
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
            if (session.error !== undefined) {
              throw session.error;
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
