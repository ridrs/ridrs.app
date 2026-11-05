<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0052: BLE Write With Response, Read and Indications in Every Central (Bridge Protocol 1.3)

Amends [ADR 0040](0040-zwift-ride-protobuf-wire-bufbuild.md) (write without response only) and [ADR 0042](0042-device-links-in-the-peripheral-link.md) (the peripheral link). Phase 8, trainer control.

## Context

The FTMS Fitness Machine Control Point needs what the Zwift Ride did not: every command is a **Write With Response**, the trainer answers with an **indication** `80 <op code> <result>`, and what the trainer can be told is **read** from the Fitness Machine Feature characteristic (and the Supported Power Range). `BleConnection` could only write without response and subscribe.

## Decision

- **Contract** (`packages/contracts/src/ble.ts`): `write(target, data, options?: { withResponse?: boolean })`; absent means without response, as before. With response the promise resolves after the peripheral's write response and rejects on a GATT error. `read(target): Promise<Uint8Array>` is new. `subscribe` delivers indications as well as notifications: the central enables whichever the characteristic has. New constants: `2acc` (Feature), `2ad8` (Supported Power Range), `2ad9` (Control Point). Fitness Machine Status (`2ada`) has no use case yet and is left out.
- **Every central:**
  - Tauri: `ble_write` gains `with_response` (`WriteType::WithResponse`), new `ble_read` (`recv_data_from`), registered in the native app and the companion. On macOS and iOS, btleplug's `setNotifyValue` enables indications for an indicate-only characteristic.
  - noble: `writeAsync(data, !withResponse)` and `readAsync`; noble enables indications for an indicate-only characteristic itself.
  - The companion bridge: **protocol 1.3** (`main` already uses 1.2 for the signal and the advertising data of ADR 0046 and ADR 0051). `write` gains `withResponse`; `read` / `read-result` are new. ridrs sends them only to a companion of 1.3 or later; to an older one the call fails at once with "the companion speaks bridge protocol 1.2.0: a read needs 1.3.0 or later; update the companion app", never as a silent no-op (the older companion's strict messages would reject them).
  - The simulator: a GATT model (readable values, the characteristics of the table, write handlers) and an FTMS control-point model.
  - The replay central: unchanged. It connects to nothing; the recorded inputs replace the device's I/O (see [ADR 0056](0056-ftms-trainer-control.md)).
- **Android: a patched copy of `tauri-plugin-blec` 0.18.0.** Its `Peripheral.kt` always writes `ENABLE_NOTIFICATION_VALUE` to the Client Characteristic Configuration Descriptor, also for a characteristic that only indicates. On the FTMS control point the trainer then sends no answers, and FTMS refuses control-point writes while indications are off (ATT error `0xFD`, "CCCD improperly configured"). 0.18.0 is the latest release, and upstream `main` (2026-11-02) does the same. The maintainer decided on 2026-11-05: `crates/vendor/tauri-plugin-blec` is the unmodified 0.18.0 crate (MIT OR Apache-2.0, with upstream's license texts) with one change: `ENABLE_INDICATION_VALUE` for a characteristic with `PROPERTY_INDICATE` and without `PROPERTY_NOTIFY`. Android reports indications through the same `onCharacteristicChanged` and confirms them itself. Both apps use it through `[patch.crates-io]`. The change is to be offered upstream; the copy goes once a release has it.

## Consequences

- A companion and a ridrs of 1.3 control a trainer through the bridge; an older companion still forwards everything else, and ridrs says why control fails.
- The vendored crate is third-party code under its own license; `NOTICE` names the patch.
- Writes with response are slower than without: only the control point uses them, a few times a second at most.
