<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0019: Bridge Network on `tokio-tungstenite`, `mdns-sd` and `if-addrs` (Phase 3b, O1/O3)

The network half of the companion bridge is the Rust crate **`crates/ridrs-bridge`**, hosted by both apps:

- **WebSocket**: [`tokio-tungstenite`](https://crates.io/crates/tokio-tungstenite) 0.30 (MIT), on the Tokio runtime Tauri already ships. The companion listens; ridrs connects.
- **Discovery**: [`mdns-sd`](https://crates.io/crates/mdns-sd) 0.21 (MIT OR Apache-2.0), pure Rust and with no system daemon. The companion announces `_ridrs-bridge._tcp` with TXT `protocol`, `name` and `id`; ridrs browses. macOS's own `dns-sd` sees these announcements.
- **Interface addresses**: [`if-addrs`](https://crates.io/crates/if-addrs) 0.15 (MIT OR BSD-3-Clause). The companion announces **only LAN IPv4 addresses**; mobile-data CLAT addresses (`192.0.0.0/24`) and loopback are left out. ridrs ignores loopback and link-local addresses in what it resolves.

**The socket lives in Rust on every platform, not in the WebView** (O3). Android release builds set `usesCleartextTraffic=false`, and the spike showed that the WebView's `ws://` then fails at once while a Rust socket works. Over Wi-Fi both paths measured the same. Rust forwards every message to the WebView over one binary IPC channel (`tag | [socket id] | body`). Binary frames from the companion's WebView go to Rust as a byte-array argument. A raw request body was tried first; Android's IPC does not deliver it, and BLE notifications are only a few bytes. The CSPs of both apps stay unchanged.

The bridge protocol itself (pairing, GATT forwarding, heartbeat) stays in TypeScript (`packages/ble-bridge`), identical on every platform and tested headless.

No new JavaScript dependency was needed. The Node `ws` server considered in the brief (O2) is not used: the Cucumber scenarios run over an in-memory network (ADR 0020), and the headless app has no bridge connector in this phase.
