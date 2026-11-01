<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0013: Native App on Tauri 2 with an In-Process Core

The GUI composition root of Phase 3 is `apps/native`: one **Tauri 2** project (`tauri` 2.12.5, `@tauri-apps/api` / `@tauri-apps/cli` 2.12.4, Apache-2.0 OR MIT) for macOS, Android, iOS and Windows. The ridrs core, all plugins, the UI bridge and the shell run **in-process in the WebView**; there is no server between host and UI. Basis: the spike in `experiments/tauri-ble-spike/` and the maintainer decisions D1–D11 of its `HANDOVER-PHASE-3.md` (2026-11-01).

- **BLE:** an app-local Rust module (`apps/native/src-tauri/src/ble.rs`, D4) on top of **`tauri-plugin-blec` 0.18.0** (MIT OR Apache-2.0, wraps **btleplug** 0.13.5, MIT/Apache-2.0/BSD-3-Clause; D5). blec provides the platform backends, including its own Android Kotlin backend; its JS commands are bypassed because they lack a service filter, receive timestamps and binary frames. `plugins/transport-ble-tauri` maps the unchanged `ble.central` contract onto these commands.
- **Keep-awake (D7):** `keepawake` 0.6.1 (MIT) on desktop, the Screen Wake Lock API in mobile WebViews, switched by the composition root while a ride runs.
- **Headless stays:** `apps/headless` keeps running the same plugins in Node with `transport-ble-noble`. Runtime-specific plugins are excluded per host: `transport-ble-noble` at build time from the app bundle, `transport-ble-tauri` at runtime from the headless host.
- **`ui-gateway-web` is deferred (D2)** to a later phase as a headless add-on. The shell talks to the host only through the `UiBridge` port, so a WebSocket implementation can be added without touching the shell or any UI plugin.
- **Licenses (D9):** Tauri pulls in five MPL-2.0 crates (`cssparser`, `selectors`, `dtoa-short`, `option-ext`, `cssparser-macros`) and Vite uses `lightningcss` (MPL-2.0) at build time. MPL-2.0 §3.3 permits combination with (A)GPL; the maintainer approved them; they are listed in `NOTICE`.
- **Platform scope (D6):** macOS and Android are built and checked by hand; iOS is build-only until the iPhone gate of the spike is closed; Windows when hardware is available.
