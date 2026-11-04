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

export interface BleDiscoveredPeripheral {
  readonly peripheralId: string;
  readonly name: string;
  readonly serviceUuids: readonly string[];
}

export interface BleScanOptions {
  readonly serviceUuids: readonly string[];
  readonly signal?: AbortSignal;
}

export interface BleCharacteristicTarget {
  readonly serviceUuid: string;
  readonly characteristicUuid: string;
}

export interface BleConnection {
  readonly peripheralId: string;
  subscribe(
    characteristic: BleCharacteristicTarget,
    onNotification: (data: Uint8Array) => void,
  ): Promise<() => void>;
  /** Writes `data` as a Write Without Response (a command); resolves once it was sent. */
  write(characteristic: BleCharacteristicTarget, data: Uint8Array): Promise<void>;
  onDisconnected(listener: () => void): () => void;
  disconnect(): Promise<void>;
}

/**
 * The link a central reaches devices over: this device's Bluetooth (`local`, the direct link) or
 * a companion phone in the same network. Both run at once; the direct link is preferred.
 */
export const bleRouteSchema = z.enum(['local', 'companion']);

export type BleRoute = z.infer<typeof bleRouteSchema>;

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
