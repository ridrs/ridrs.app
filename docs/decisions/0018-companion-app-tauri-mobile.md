<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0018: Companion App on Tauri 2 Mobile (Phase 3b, B1)

The companion app (`apps/companion`) forwards a phone's Bluetooth to ridrs over the local network. It is a **Tauri 2 app for Android and iOS** with a React UI, the same toolchain as `apps/native` (ADR 0013, 0014). Native Swift/Kotlin and Flutter/React Native were rejected: they would duplicate the Rust BLE layer and the TypeScript bridge protocol.

- The Rust BLE commands moved from `apps/native` into the crate **`crates/ridrs-ble`**, which both apps host (extend, don't fork). The TypeScript side (`TauriBleCentral`) moved from `plugins/transport-ble-tauri` into **`packages/ble-tauri`**, so the companion can use it without importing a plugin.
- Both apps keep `tauri-plugin-blec` as a **direct** dependency: Tauri collects a plugin's Android module only from direct dependencies.
- The companion is **foreground-only** on Android. The activity keeps the screen on, requests `ACCESS_LOCAL_NETWORK` and holds a multicast lock and a `WIFI_MODE_FULL_LOW_LATENCY` lock while resumed. Each of these was needed in the spike (`experiments/ble-bridge-spike/FINDINGS.md`).
- The **developer build** (`vite build --mode dummy`, `VITE_DUMMY_DEVICES=true`) adds dummy BLE devices from `packages/ble-simulator`. The simulator moved there from `packages/testing`, which re-exports it. A release build drops that code at build time; a Vitest bundle test and a dependency-cruiser rule guard this.
