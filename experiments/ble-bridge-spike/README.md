<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# BLE bridge spike (Phase 3b, step 0)

Time-boxed spike for open items O1–O3 of `ridrs_elephant/prompts/03b-phase-3b-ble-bridge-companion.md`:
can a Tauri 2 companion on a phone advertise itself over mDNS and serve a WebSocket, and can a
Tauri host (ridrs) find it and read raw frames, from the WebView or from Rust?

No BLE here: the Tauri BLE spike (`../tauri-ble-spike`) already covered that. The companion sends
synthetic FTMS frames (`u32 seq | u64 mono µs | f64 wall ms | payload`) at a rate the host picks.
Results: [FINDINGS.md](FINDINGS.md).

```text
src-tauri/src/companion.rs  WebSocket listener (tokio-tungstenite) + mDNS advertise (mdns-sd)
src-tauri/src/host.rs       mDNS browse + Rust-side WebSocket client (O3 fallback path)
src/main.ts                 role UI; host auto test: WebView ws:// and Rust path at 4 Hz and 200 Hz
node/probe.mjs              O2: Node global WebSocket client and a `ws` stand-in companion
```

## Run

```bash
npm install
(cd src-tauri && cargo test)
npx tauri build --bundles app
```

Roles: `SPIKE_ROLE=companion|host|both` on desktop, or tap a role in the app (remembered).
Every result line goes to stdout as `SPIKE {json}` (desktop) and to logcat (`Tauri/Console`).

```bash
# macOS host against whatever companion is on the network
SPIKE_ROLE=host "src-tauri/target/release/bundle/macos/ridrs bridge spike.app/Contents/MacOS/ridrs-ble-bridge-spike"

# Node client against a companion (address from the companion screen)
node node/probe.mjs client ws://192.168.1.20:42229
```

Android (same environment as the BLE spike):

```bash
export ANDROID_HOME="$HOME/Library/Android/sdk"
export NDK_HOME="$ANDROID_HOME/ndk/28.2.13676358"
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
npx tauri android build --apk --debug --target aarch64
adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

`gen/android` is hand-edited after `tauri android init`: `ACCESS_LOCAL_NETWORK` in the manifest,
and `MainActivity.kt` keeps the screen on and requests that permission (see FINDINGS).
