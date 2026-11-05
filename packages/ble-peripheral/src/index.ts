// SPDX-License-Identifier: AGPL-3.0-or-later

// BLE building blocks shared by plugins: the device side's connection lifecycle and, for
// centrals whose platform runs one scan at a time, scan sharing between device plugins.
export {
  type BlePeripheralLink,
  type BlePeripheralLinkOptions,
  startBlePeripheralLink,
} from './link.ts';
export { type DeviceMemory, loadDeviceMemory } from './memory.ts';
export { type NativeScan, SharedBleScan, type StartNativeScan } from './shared-scan.ts';
