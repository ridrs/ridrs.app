// SPDX-License-Identifier: AGPL-3.0-or-later

// BLE building blocks shared by plugins: the device side's connection lifecycle (of a device, and
// of a device made of several parts) and, for
// centrals whose platform runs one scan at a time, scan sharing between device plugins.
export {
  type BlePeripheralLink,
  type BlePeripheralLinkOptions,
  startBlePeripheralLink,
} from './link.ts';
export {
  type DeviceMemory,
  type DevicePartsMemory,
  loadDeviceMemory,
  loadDevicePartsMemory,
} from './memory.ts';
export {
  type BlePartsLink,
  type BlePartsLinkOptions,
  type DevicePartOf,
  startBlePartsLink,
} from './parts.ts';
export { type NativeScan, SharedBleScan, type StartNativeScan } from './shared-scan.ts';
export { type DeviceLinkCommands, DeviceStatusBoard, registerDeviceLink } from './status.ts';
