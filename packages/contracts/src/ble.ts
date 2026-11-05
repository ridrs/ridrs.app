// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { defineCapability } from './capabilities.ts';

/**
 * Canonical 16-bit UUID for the Bluetooth Fitness Machine Service (FTMS, 0x1826).
 * All 16-bit BLE UUIDs in ridrs contracts use 4-character lowercase hexadecimal strings.
 */
export const FTMS_SERVICE_UUID = '1826';

/**
 * Canonical 16-bit UUID for the FTMS Indoor Bike Data characteristic (0x2AD2).
 */
export const INDOOR_BIKE_DATA_CHARACTERISTIC_UUID = '2ad2';

/**
 * FTMS Fitness Machine Feature (0x2ACC), read once per connection: two little-endian uint32,
 * the machine features and the target setting features (FTMS 1.0, 4.3).
 */
export const FITNESS_MACHINE_FEATURE_CHARACTERISTIC_UUID = '2acc';

/** FTMS Supported Power Range (0x2AD8): minimum and maximum sint16 W, increment uint16 W. */
export const SUPPORTED_POWER_RANGE_CHARACTERISTIC_UUID = '2ad8';

/**
 * FTMS Fitness Machine Control Point (0x2AD9): written with response, answered by an indication
 * `80 <op code> <result>` (FTMS 1.0, 4.16).
 */
export const FITNESS_MACHINE_CONTROL_POINT_CHARACTERISTIC_UUID = '2ad9';

/** Canonical 16-bit UUID for the Bluetooth Battery Service (0x180F). */
export const BATTERY_SERVICE_UUID = '180f';

/** Canonical 16-bit UUID for the Battery Level characteristic (0x2A19): one byte, 0 to 100 %. */
export const BATTERY_LEVEL_CHARACTERISTIC_UUID = '2a19';

/** Canonical 16-bit UUID for the Bluetooth Heart Rate Service (0x180D). */
export const HEART_RATE_SERVICE_UUID = '180d';

/** Canonical 16-bit UUID for the Heart Rate Measurement characteristic (0x2A37). */
export const HEART_RATE_MEASUREMENT_CHARACTERISTIC_UUID = '2a37';

/**
 * Zwift Ride controller service (0xFC82, advertised and on GATT). Its characteristics carry 128-bit
 * Zwift UUIDs: notifications (keypad, battery) and the control point that wants a "RideOn" first.
 */
export const ZWIFT_RIDE_SERVICE_UUID = 'fc82';

/** Zwift Ride notifications: keypad status, battery and others, each led by an opcode byte. */
export const ZWIFT_RIDE_NOTIFY_CHARACTERISTIC_UUID = '00000002-19ca-4651-86e5-fa29dcdd09d1';

/** Zwift Ride control point: written without response. */
export const ZWIFT_RIDE_CONTROL_POINT_CHARACTERISTIC_UUID = '00000003-19ca-4651-86e5-fa29dcdd09d1';

const BLUETOOTH_BASE_UUID_REGEX = /^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/;

/**
 * Normalizes a BLE UUID into the canonical ridrs form (4-character lowercase hex for 16-bit UUIDs,
 * e.g. `"0x1826"` or `"00001826-0000-1000-8000-00805f9b34fb"` -> `"1826"`).
 */
export function normalizeBleUuid(uuid: string): string {
  const cleaned = uuid.trim().toLowerCase().replace(/^0x/, '');
  const baseMatch = BLUETOOTH_BASE_UUID_REGEX.exec(cleaned);
  if (baseMatch?.[1]) {
    return baseMatch[1];
  }
  if (/^[0-9a-f]{1,4}$/.test(cleaned)) {
    return cleaned.padStart(4, '0');
  }
  return cleaned;
}

/** Advertised bytes by key, both as lowercase hex: JSON, for the bridge and recordings. */
export type BleAdvertisedData = Readonly<Record<string, string>>;

export interface BleDiscoveredPeripheral {
  readonly peripheralId: string;
  readonly name: string;
  readonly serviceUuids: readonly string[];
  /** Signal strength of the advertisement in dBm, when the platform reports it. */
  readonly rssi?: number;
  /**
   * Manufacturer specific data: the company id (4 hex digits) → the bytes after it. Absent when
   * the device advertises none. Tells devices of one name apart across links.
   */
  readonly manufacturerData?: BleAdvertisedData;
  /** Service data: the normalized service UUID → its bytes. Absent when the device sends none. */
  readonly serviceData?: BleAdvertisedData;
  /**
   * The device is gone, reported once by a scan that knows it (a removed dummy device): it is
   * not heard again unless it comes back. Platform Bluetooth never knows; its devices just fall
   * silent.
   */
  readonly vanished?: boolean;
}

/**
 * A scan reports every device it still hears at least this often, news or not: a device not
 * reported for a while has fallen silent.
 */
export const BLE_SCAN_REPORT_INTERVAL_MS = 5000;

/** Manufacturer data as the platforms report it: the company id as a number. */
export function hexByCompany(
  data: Iterable<readonly [number, Uint8Array | readonly number[]]>,
): BleAdvertisedData | undefined {
  const entries = [...data].map(
    ([company, bytes]) => [company.toString(16).padStart(4, '0'), toHex(bytes)] as const,
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** Service data as the platforms report it: the service UUID in any form. */
export function hexByService(
  data: Iterable<readonly [string, Uint8Array | readonly number[]]>,
): BleAdvertisedData | undefined {
  const entries = [...data].map(([uuid, bytes]) => [normalizeBleUuid(uuid), toHex(bytes)] as const);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function toHex(bytes: Uint8Array | readonly number[]): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface BleScanOptions {
  readonly serviceUuids: readonly string[];
  readonly signal?: AbortSignal;
}

export interface BleCharacteristicTarget {
  readonly serviceUuid: string;
  readonly characteristicUuid: string;
}

export interface BleWriteOptions {
  /**
   * A Write With Response: resolves after the peripheral's write response and rejects on a GATT
   * error. Absent or false: a Write Without Response, resolved once it was sent.
   */
  readonly withResponse?: boolean;
}

export interface BleConnection {
  readonly peripheralId: string;
  /** Notifications and indications alike: the central enables whichever the characteristic has. */
  subscribe(
    characteristic: BleCharacteristicTarget,
    onNotification: (data: Uint8Array) => void,
  ): Promise<() => void>;
  /** Writes `data`, without response unless asked for. */
  write(
    characteristic: BleCharacteristicTarget,
    data: Uint8Array,
    options?: BleWriteOptions,
  ): Promise<void>;
  /** Reads the characteristic's value. */
  read(characteristic: BleCharacteristicTarget): Promise<Uint8Array>;
  onDisconnected(listener: () => void): () => void;
  disconnect(): Promise<void>;
}

/**
 * The link a central reaches devices over: this device's Bluetooth (`local`, the direct link) or
 * a companion phone in the same network. Both run at once; the direct link is preferred.
 */
export const bleRouteSchema = z.enum(['local', 'companion']);

export type BleRoute = z.infer<typeof bleRouteSchema>;

/**
 * What a device plugin's link remembers on this machine (ADR 0054): the device it connected last,
 * by its link and its id on that link, or that the rider forgot the device.
 */
export const rememberedDeviceSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('chosen'),
      route: bleRouteSchema,
      peripheralId: z.string().min(1),
      name: z.string(),
    })
    .strict(),
  z.object({ state: z.literal('forgotten') }).strict(),
]);

export type RememberedDevice = z.infer<typeof rememberedDeviceSchema>;

export interface BleCentral {
  /** The link this central stands for; `local` when absent. */
  readonly route?: BleRoute;
  scan(options: BleScanOptions): AsyncIterable<BleDiscoveredPeripheral>;
  connect(
    peripheralId: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<BleConnection>;
}

/** One provider per link: this device's Bluetooth and the companion bridge run side by side. */
export const bleCentralCapability = defineCapability<BleCentral, 'multiple', 'ble.central'>(
  'ble.central',
  { cardinality: 'multiple' },
);
