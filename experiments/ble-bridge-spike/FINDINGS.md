<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# BLE bridge spike: findings (2026-11-02)

Spike for Phase 3b open items O1–O3. Setup: MacBook (macOS, release build, origin `tauri://localhost`)
and Pixel 8 (Android 17, SDK 37, debug build, `targetSdk 37`) on the same FritzBox Wi-Fi
(192.168.178.0/24). Companion sends synthetic FTMS frames; the host measures connect time, loss,
gaps, RTT and one-way latency (clock offset from the minimum-RTT ping, NTP style).

## Verdict

**Go**, with five Android requirements that belong in the Phase 3b brief (see "Consequences").

| Item | Result |
|---|---|
| O1 Rust crates | `tokio-tungstenite` 0.30 (MIT) + `mdns-sd` 0.21 (MIT/Apache-2.0) + `if-addrs` 0.15 work on macOS and Android, compiled first try. `mdns-sd` adverts are seen by Apple's `dns-sd`. |
| O2 Node | Node 26 global `WebSocket` client works against both `ws` 8.22 and the Rust companion; 0 lost frames at 200 Hz. |
| O3 WebView `ws://` to LAN | **macOS release (`tauri://localhost`): works**, ~30 ms connect, no CSP/ATS issue. **Android debug (`http://tauri.localhost`): works.** **Android with `usesCleartextTraffic=false` (what Tauri sets for release): the WebView fails at once, the Rust path works.** So on Android the socket belongs in Rust (or a network security config allowing cleartext to the LAN). |

## Measurements

macOS loopback (companion and host in one app, LAN address), release:

| Path | Rate | Frames / lost | One-way median / p95 / max |
|---|---|---|---|
| WebView | 4 Hz, 15 s | 60 / 0 | 0.48 / 1.22 / 1.48 ms |
| WebView | 200 Hz, 10 s | 2000 / 0 | 0.92 / 1.60 / 2.15 ms |
| Rust | 4 Hz | 60 / 0 | 0.66 / 1.49 / 1.72 ms |
| Rust | 200 Hz | 2000 / 0 | 0.74 / 1.45 / 3.01 ms |

Pixel companion → macOS host over Wi-Fi:

| | No Wi-Fi locks (2 runs) | Multicast lock + `WIFI_MODE_FULL_LOW_LATENCY` |
|---|---|---|
| mDNS discovery | 7.2 s, 63.3 s | **0.24 s** |
| WebView 4 Hz: frames / median / p95 / max | 10 of 60 sent (sender back-pressured) / 72 / 274 / 274 ms; 60 / 44 / 160 / 367 ms | 60 / **20 / 116 / 165 ms** |
| WebView 200 Hz | max gap **14.7 s**, p95 880 ms; p95 386 ms | 2009 frames, **22 / 130 / 355 ms**, max gap 345 ms |
| Rust 4 Hz | 59 / 49 / 213 / 567 ms | 60 / 23 / 115 / 575 ms |
| Rust 200 Hz | n/a | 20 / 170 / 331 ms |
| RTT median | 26–72 ms | 27–51 ms |
| Lost frames | 0 | 0 |

macOS companion → Pixel host (Pixel as ridrs; manual URL, the Mac had moved to 192.168.178.95):

| Build | Path | 4 Hz: frames/lost, one-way median / p95 | 200 Hz: lost, one-way median / p95 / max |
|---|---|---|---|
| debug (cleartext on) | WebView | 60/0, 10.0 / 22.0 ms (connect 977 ms) | 0, 6.0 / 14.9 / 30.8 ms |
| debug (cleartext on) | Rust | 56/0, 12.9 / 18.2 ms | 0, 9.0 / 22.5 / 53.3 ms |
| `usesCleartextTraffic=false` | WebView | **connect fails: error before open** | – |
| `usesCleartextTraffic=false` | Rust | 60/0, 10.6 / 25.0 ms | 0, 8.0 / 16.7 / 36.9 ms |

Pixel host discovered the Mac companion in 148 ms (it holds the multicast lock). Receiving on the
phone is much better than sending from it: the phone's uplink power save is the weak side.

WebView and Rust paths are indistinguishable over Wi-Fi: the radio dominates. Phone clock was
~580–630 ms off the Mac, which confirms that companion times must stay diagnostics only.

## Android findings (all hit in practice)

1. **Local Network Protection.** On Android 17 with `targetSdk 37`, inbound TCP to the app's port was
   silently dropped (the phone's ADB port on the same IP accepted). Fixed by declaring and requesting
   the runtime permission `android.permission.ACCESS_LOCAL_NETWORK` (protection level dangerous).
2. **Screen off = no network.** With the screen off or locked the app's uid is firewalled
   (`netpolicy`: `APP_BACKGROUND`, later `DOZE|APP_BACKGROUND`, procState `TPSL`). The companion
   must keep the screen on (`FLAG_KEEP_SCREEN_ON`) and stay in the foreground.
3. **Multicast lock is required for discovery.** Without `WifiManager.MulticastLock`, discovery
   took 7–63 s; with it 0.24 s.
4. **Wi-Fi power save causes multi-second stalls.** Without a `WIFI_MODE_FULL_LOW_LATENCY` lock,
   one 200 Hz run had a 14.7 s gap and the sender back-pressured to 10 frames in 15 s. With it the
   longest gap was 0.79 s. Remaining p95 of ~115–170 ms is Wi-Fi jitter; FTMS at ~4 Hz and the 3 s
   metric silence timeout tolerate it, Phase 4 should treat bridged receive times as jittery.
5. **Advertised addresses.** `if-addrs` on Android also returns the cellular CLAT address
   `192.0.0.4`; mDNS on macOS also resolves `127.0.0.1` for a local service. The companion should
   advertise Wi-Fi interface addresses only and the host must skip loopback/link-local.

Also: macOS took 4.9 s for the first WebView LAN connect after install (likely the Local Network
permission prompt), ~30 ms afterwards. Wireless ADB dropped once during the session.

## Not yet verified

- A real signed Android release build (the cleartext case was reproduced by flipping the debug
  manifest placeholder; the phone currently has that variant installed).
- iOS (no iPhone run; `Info.plist` already carries `NSLocalNetworkUsageDescription` and
  `NSBonjourServices`).
- Long runs (30 min), Wi-Fi roaming, phone switching networks.

## Consequences for the Phase 3b brief

- O1: take `tokio-tungstenite` + `mdns-sd` (ADRs). O2: take `ws` for the Node server side.
- O3: keep the `BridgeSocket` port. Use the WebView socket on macOS (and Node's on headless);
  use a Rust socket over an IPC channel on Android (release blocks WebView cleartext), the same
  pattern as `transport-ble-tauri`. Protocol code is unaffected either way.
- A reloaded WebView does not stop Rust-side servers: the companion must own its listener's
  lifecycle explicitly (the spike's host found its own still-running companion after a reload).
- Companion Android shell: `ACCESS_LOCAL_NETWORK` runtime permission, keep-screen-on, multicast
  lock, low-latency Wi-Fi lock, all held only while the companion screen is in the foreground.
- Advertise Wi-Fi addresses only; host filters loopback/link-local.
- The protocol must survive multi-hundred-ms gaps without declaring the link dead (heartbeat timeout
  ≥ 3 s), and ridrs must never use the companion clock for measurement time.
