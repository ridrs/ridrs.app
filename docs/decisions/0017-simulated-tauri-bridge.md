<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0017: Simulated Tauri Bridge on `@tauri-apps/api/mocks`

`plugins/transport-ble-tauri` is tested in Cucumber against a **simulated Tauri bridge** (`SimulatedTauriBridge` in `@ridrs/testing`) that answers the Rust `ble_*` commands with the existing `BleSimulator`. It intercepts IPC with **`mockIPC` from `@tauri-apps/api/mocks`** (Tauri's own test helper, same package and license as `@tauri-apps/api`), so the plugin runs unchanged with the real `invoke` and `Channel`; no test-only seam leaks into the plugin's runtime code. The Tauri mocks expect a browser `window`; the bridge points `window` at the global object while installed.

The adapter's own unit tests (ported from the spike) use a small in-memory `BleIpc` fake for fine-grained checks of abort and once-per-loss semantics.
