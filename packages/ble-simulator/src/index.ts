// SPDX-License-Identifier: AGPL-3.0-or-later

// An in-process BLE world: simulated peripherals behind a `BleCentral`. Used by the tests and,
// as dummy devices, by the developer build of the companion app (never by a release build).
export {
  BleSimulator,
  SimulatedPeripheral,
  type SimulatedPeripheralOptions,
} from './ble-simulator.ts';
export {
  DUMMY_PROFILES,
  type DummyDevice,
  DummyDevices,
  type DummyProfile,
  mergeBleCentrals,
} from './dummy-devices.ts';
