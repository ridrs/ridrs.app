<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0020: Bridge Scenarios on a Simulated Network

The Phase 3b scenarios exercise the real bridge protocol (`packages/ble-bridge`), the real `transport-ble-bridge` plugin and the unchanged device and metric plugins. Only the network is simulated: **`SimulatedNetwork`** in `@ridrs/testing` provides DNS-SD-style announcements, message-framed socket pairs, stalls (Wi-Fi power save) and departures. Messages are delivered as microtasks, so `@sinonjs/fake-timers` (ADR 0011) fully controls heartbeats, timeouts and reconnect backoff.

This deviates from the brief, which asked for scenarios over a real localhost WebSocket server. Real sockets deliver on the event loop's I/O phase, which fake timers do not control. Heartbeat and timeout scenarios ("a 4 s stall is no connection loss, 5 s is") would become timing-dependent, against standing rule 7 (Determinism).

The real socket code is covered elsewhere: by unit tests of the IPC adapters (`bridge-connector-tauri`, `apps/companion/src/ipc-server.ts`), Rust unit tests in `crates/ridrs-bridge`, and the manual checks against the Android emulator and a phone.
