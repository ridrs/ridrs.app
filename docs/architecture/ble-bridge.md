<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# The Companion Bridge (Phase 3b)

A phone next to the bike holds the Bluetooth link; ridrs on another device in the same network receives the trainer's data. **The network is just another transport**: the companion is a remote `ble.central`. It forwards raw GATT traffic and never decodes payloads. `device-ftms-trainer`, the metrics, the activity and the UI widgets are unchanged.

```text
 Companion (phone, apps/companion)                        ridrs (apps/native)
 ──────────────────────────────────                       ─────────────────────────────────────────
 trainer ◄─BLE─► ridrs-ble (Rust, blec)                    device-ftms-trainer ◄─ble.central─┐
                     │ IPC                                                                    │
                 TauriBleCentral (+ dummy devices, dev)    transport-ble-bridge (BridgeLink) ─┘
                     │                                          │ BridgeSession (packages/ble-bridge)
                 BridgeServer + PairingAuthority                │ ble-bridge.connector
                 (packages/ble-bridge)                          │
                     │ IPC                                 bridge-connector-tauri
                 ridrs-bridge::server ─── WebSocket, mDNS ─── ridrs-bridge::client (Rust)
```

## Protocol (`packages/contracts/src/ble-bridge.ts`)

WebSocket. Text messages are JSON (validated with zod); binary messages are notification frames (`u32 LE subscription id | f64 LE companion time | payload`). The companion time is diagnostics only. ridrs stamps `receivedAt` with its own clock; the spike measured a phone clock 0.6 s off.

| ridrs → companion | companion → ridrs |
|---|---|
| `hello` (protocol, client name, pairing secret, pairing code or token) | `welcome` (companion id and name, token) or `rejected` (`bad-code`, `bad-token`, `locked`, `incompatible`, `busy`, `unknown-secret`) |
| `ping` every 1 s | `pong` |
| `scan`, `stop-scan` | `discovered` (from 1.2 signal strength and manufacturer and service data as hex, only to a client of 1.2 or later, [ADR 0046](../decisions/0046-one-link-per-device-and-signal-strength.md), [ADR 0051](../decisions/0051-same-device-over-both-links-by-advertising-data.md)) |
| `connect`, `disconnect` | `connected`, `disconnected`, `failed`, `connection-lost` |
| `subscribe`, `unsubscribe` | `subscribed`, binary frames |
| `write` (hex bytes, Write Without Response; protocol 1.1; from 1.3 `withResponse`) | `written` or `failed` |
| `read` (protocol 1.3) | `read-result` (hex bytes) or `failed` |

- **Pairing**: either the phone scans the QR code ridrs shows (`hello.pairingSecret`, ADR 0021), or the rider types the 6-digit code the phone shows into ridrs (`hello.pairingCode`). Both earn a token, which ridrs stores for later connects. A scanned secret is good for one pairing within ten minutes, and misses never lock. Five wrong codes lock code pairing for a minute, and the phone shows a fresh code after a successful one. "Forget paired ridrs" revokes all tokens.
- **One ridrs at a time**: a second client is rejected with `busy`.
- **Liveness**: any inbound message counts. After 5 s of silence either side closes the link; shorter Wi-Fi stalls (up to 0.8 s seen with the Wi-Fi locks) are no connection loss. When the link closes, the companion releases every scan, subscription and Bluetooth connection of that client.
- **Versions**: a companion accepts clients of the same major protocol version. ridrs sends a write with response or a read only to a companion of 1.3 or later; to an older one the call fails at once and says why ([ADR 0052](../decisions/0052-ble-write-with-response-read-and-indications.md)).

## Connection states: both devices agree, and there is always a way out

| ridrs (`bridge.state-changed`) | Companion (per paired ridrs) | Buttons in ridrs | Buttons on the phone |
|---|---|---|---|
| `unpaired` (QR code, code fields) | no pairing | pair | scan QR / show code |
| `connecting`, `reconnecting` | `waiting` | Forget | Forget |
| `unreachable` (after 30 s, with a reason and a hint) | `waiting` | Try again, Forget | Forget |
| `connected` | `connected` | Forget | Disconnect, Forget |
| `disconnected` (`by-ridrs` / `by-companion`) | `disconnected` | Connect, Forget | Connect, Forget |

- **Deliberate ends are announced**: `bye` (`disconnect` or `forget`) goes out before the socket closes, so the other side shows the same at once. Only an unexpected loss can differ, for up to the 5 s link timeout.
- **A disconnect stays until someone connects.** The companion holds the pause, which survives restarts of either app. ridrs keeps asking every 3 s with `intent: reconnect`, which a paused pairing refuses (`paused`, `pausedBy`). Connect on the phone lifts the pause, and ridrs's next attempt succeeds. Connect in ridrs sends `intent: resume`, which lifts it too.
- **Forget reaches both sides.** If the companion is away when the rider forgets in ridrs, ridrs is unpaired at once and delivers `intent: forget` once the companion is back. If the phone forgets while ridrs is away, ridrs learns it from `bad-token` on its next attempt.
- **Connecting never hangs**: the Rust connect gives up after 5 s, and ridrs reports `unreachable` after 30 s with `refused`, `network`, `timeout` or `error`, while it keeps trying (every 1, 2, 4 and then 5 s).
- A ridrs that connects again while the companion still holds its old session (not yet timed out) replaces that session instead of getting `busy`.
- The `@consistent` scenarios (`tests/features/bridge/bridge-control.feature`) check after every step that "connected" on one side means "connected" on the other.

## ridrs side

- `transport-ble-bridge` provides a `ble.central` with `route: 'companion'` and requires `ble-bridge.connector`. Its `BridgeLink` keeps one session to the paired companion: scans wait for a session, connects wait for the attempt in flight. A lost session ends every open BLE connection, so the device plugin reconnects by id as usual; the bridge reconnects with backoff (1 s, doubling, max 30 s) and reports `bridge-unreachable` once per outage. A refused token clears the pairing.
- Events: `bridge.companions-changed` (listed companions, paired flag), `bridge.pairing-offer` (the QR code URI while nothing is paired, `null` otherwise), `bridge.pair-requested` (address of a listed companion + code, from the UI), `bridge.state-changed` (`unpaired`, `connecting`, `connected`, `reconnecting`, `rejected`).
- Discovery is mDNS only: there is no field for typing an address.
- `bridge-connector-tauri` provides the connector: mDNS browse and sockets in Rust (`crates/ridrs-bridge`), pairing in the WebView's local storage. A companion that moved to another address is found again by its id in the announcements.
- The companion has its own row in the device setup (`ui-devices`, see [ui-and-activity.md](ui-and-activity.md)): its status, and in its details Connect or Try again, and Remove (it forgets the companion). ridrs offers no Disconnect: `bridge.disconnect-requested` stays in the contract (the protocol and `bridge-control.feature` use it), but no UI publishes it. `ui-bridge-pairing` contributes the pairing to the extension point `setup/companion` of those details: while nothing is paired, two ways side by side, Scan the QR code or Enter the code (six digits) for each companion found; the sixth digit pairs, with no button to press.
- **Both links at once** ([ADR 0042](../decisions/0042-device-links-in-the-peripheral-link.md)): `ble.central` is `multiple`. This device's Bluetooth and the companion both provide one, and `@ridrs/ble-peripheral` lists a device both see once per link and connects it over one of them, the direct link first, with no failover; the rider switches by connecting the device found over the other link ([ADR 0046](../decisions/0046-one-link-per-device-and-signal-strength.md), [devices-and-metrics.md](devices-and-metrics.md)). There is no transport to switch and no restart. A damaged stored pairing is discarded, and the rider pairs again.

## Companion side

`apps/companion` composes `PairingAuthority` and `BridgeServer` on the Rust listener (`serveOverIpc`). The UI offers **Scan ridrs QR code** (native camera scanner), shows the code as the alternative, the connected ridrs and the forwarding rate. It listens on port 42229 when that port is free. On Android the activity keeps the screen on and holds a multicast lock and a low-latency Wi-Fi lock while in the foreground; it also needs `ACCESS_LOCAL_NETWORK` (see the spike findings). The developer build (`--mode dummy`) merges dummy devices from `packages/ble-simulator` into the forwarded central.

## Tests

The scenarios in `tests/features/bridge/`, `tests/features/devices/trainer-connection-bridge.feature` and `tests/features/apps/ride-over-bridge.feature` run the real protocol and plugins on a simulated network (`SimulatedNetwork`, `SimulatedCompanion` in `@ridrs/testing`; ADR 0020). Vitest covers the IPC adapters and that release bundles leave the dummy devices out; `cargo test` covers address filtering and event framing.
