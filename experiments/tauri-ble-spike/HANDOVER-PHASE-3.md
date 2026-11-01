<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# Handover to Phase 3: results of the Tauri 2 + native BLE spike

**For:** the agent implementing Phase 3. Read it together with
`prompts/03-phase-3-activity-and-gui.md` (the "brief") and `prompts/tech-stack-ui-and-bluetooth.md`
(the "tech-stack doc"). You do not need to read the spike code. Details and raw numbers are in
[FINDINGS.md](FINDINGS.md); this document links to the relevant sections.

**Date of the measurements:** 2026-11-01. **Spike folder:** `experiments/tauri-ble-spike/`.
Notation: ✅ works · ⚠️ works with caveats · ❌ fails · NV = not verified. "Assumption:" marks an
inference that was not tested.

---

## 1. Verdict

**Provisional GO for Tauri 2 (tech-stack doc §9, first row), with three open gates.** No check failed
(❌) on any platform. The biggest named risk, mobile BLE through Tauri, has positive evidence on a
real Android phone. But the §9 condition ("must-pass checks green on all four platforms") is **not**
met yet.

**Only a heart-rate device was tested over BLE.** It was a Xiaomi Smart Band 10 wristband serving the
standard HR service `0x180D`, not a chest strap. It was connected only on Android (Pixel 8). No FTMS
trainer, no FTMS control-point write and no Zwift Ride were tested on any platform. macOS only scanned.

Why GO and not SPLIT or NO-GO:

- SPLIT (§9 row 2) requires "mobile BLE fails". On Android it works on real hardware: scan without a
  picker, service filter, connect, live notifications, and reconnect by id after an app restart (§2).
  On iOS it is untested, not failed.
- NO-GO for Windows (§9 row 3) requires "Windows BLE fails". Windows is untested.

**Open gates** (the verdict is provisional until each one is closed):

1. **iPhone on a device:** HR scan, connect, notify, reconnect. The iOS Simulator has no Bluetooth.
2. **FTMS trainer** on macOS, Android and iOS: checks 5, 6, 8, 11.
3. **Windows 10/11 PC** with BLE: checks 1–11.

**Maintainer decisions (2026-11-01):** all recommendations in §10 were accepted. See §10.

**What this means for Phase 3:** the first step (runtime-neutral core, bundled discovery,
`apps/native` skeleton, `transport-ble-tauri`) is needed in **every** §9 outcome. The SPLIT fallback
also runs the core in a WebView. So the first step can start now. Gate 1 decides whether `apps/native`
ships iOS or iOS moves to Capacitor; it should be closed before `apps/native` is declared the main
composition root (see §10, decision D1).

---

## 2. Evidence

### 2.1 Results matrix

Full cell texts: [FINDINGS §3](FINDINGS.md#3-results-matrix-brief-section-5). iOS results come
from the iOS Simulator (no Bluetooth). Android results come from a real **Pixel 8** (Android 17,
API 37, debug build); the emulator only confirms install and stage 2.

| # | Check | Windows | macOS | iOS | Android |
|---|---|---|---|---|---|
| 1 | Builds, installs, starts from one project | NV | ✅ | ⚠️ device IPA builds and is signed; installs and starts in the simulator; device NV | ✅ Pixel 8 + emulator |
| 2 | Permission flow | NV | ⚠️ key present, prompt not exercised | ⚠️ key present in IPA, prompt NV | ⚠️ "Nearby devices" granted, **no location requested**; deny flow NV |
| 3 | Scan without system picker | NV | ⚠️ no picker; 18–31 devices; no trainer | NV | ⚠️ no picker; 50 devices; no trainer |
| 4 | Scan filtered by service UUID | NV | ⚠️ runs; no positive match | NV | ✅ HR filter `180d` → exactly the 2 HR devices |
| 5 | FTMS Indoor Bike Data via the real parser | NV | NV | NV | NV |
| 6 | ≈4 Hz, no gaps > 1 s over 30 min | NV | NV | NV | NV |
| 7 | HR notifies in parallel with the trainer | NV | NV | NV | ⚠️ HR notifies (parallel to a scan); no trainer |
| 8 | Peripheral off → `connection-lost` ≤ 5 s | NV | NV | NV | NV |
| 9 | Reconnect by remembered id, no new scan | NV | NV | NV | ⚠️ works after an app restart (HR band); after a peripheral power cycle NV |
| 10 | Peripheral id stable across restarts | NV | ⚠️ (static-address device only) | NV | ✅ |
| 11 | FTMS control point write + indication | NV | NV | NV | NV |
| 12 | Zwift Ride, 4 connections | NV | NV | NV | NV |
| 13 | Screen lock / background 2 min | NV | NV | NV | NV |
| 14 | Real ridrs code: probe stage reached | NV | 2 | 2 (simulator) | 2 |
| 15 | IPC latency | NV | ⚠️ synthetic | ⚠️ synthetic (simulator) | ⚠️ real HR + synthetic, debug |
| 16 | App size / cold start | NV | ✅ measured | ⚠️ debug only | ✅ measured (debug cold start) |
| 17 | Build friction | NV | low | medium | medium |

### 2.2 Key numbers

Conditions: build host MacBook Pro M3 Pro, macOS 26.7.1. Pixel 8 on Android 17 with WebView 156,
debug APK. Synthetic notifications are frames that Rust pushes through the same binary channel real
notifications use. Details: [FINDINGS §4](FINDINGS.md#4-measurements).

| Quantity | Value | Conditions |
|---|---|---|
| HR notification rate | **0.63 /s**: 36 notifications in 55.9 s; interval min 778 ms, median 1994 ms, max 2046 ms | Pixel 8, Xiaomi Smart Band 10. **Not measured over 30 min** (only 56 s). The intervals are the band's own rate, so the "> 1 s gap" criterion does not apply to HR |
| Gaps > 1 s over 30 min (FTMS) | **not measured** | no trainer |
| Time to detect a lost connection | **not measured** | the band could not be switched off on demand; toggling the phone's Bluetooth (a system setting) was not done |
| Connect time | 1429 ms after a scan; **1813 ms by remembered id after an app restart** | Pixel 8, HR band. The 1813 ms includes an internal short scan by the BLE library (§4.4) |
| Reconnect after loss (in-process) | **not measured** | needs a peripheral that can be switched off |
| IPC latency, real BLE notifications | median **3.49 ms**, p95 **23.12 ms** (n=36) | Pixel 8, debug build. Rust receive timestamp → JS handler, clocks offset-corrected |
| IPC latency, synthetic at 4 Hz | macOS 0.79 / 1.36 ms · iOS Simulator 0.74 / 1.58 ms · Pixel 8 5.90 / 20.61 ms (median / p95) | n=120. macOS release; simulator and Pixel 8 debug. ±1 ms resolution in WKWebView |
| IPC latency, synthetic at 200 Hz | macOS 0.48 / 0.98 ms · iOS Simulator 0.74 / 1.25 ms · Pixel 8 2.27 / 4.17 ms | n=1000, **0 frames lost** on every target |
| App size | macOS `.app` **5.3 MiB** (release, arm64) · Android APK **8.3 MB** (release, arm64, unsigned) · iOS IPA 18.6 MB (debug) | |
| Cold start (Rust process start → first JS IPC call) | macOS **399–533 ms** (release, 5 launches) · Pixel 8 **2395 ms** (debug, first launch after install) · Android emulator 445 ms · iOS Simulator 964–1584 ms (debug) | |

---

## 3. Tech-stack decision summary: confirmed / changed / untested

One row per row of tech-stack doc §2.

| Concern (tech-stack §2) | Status | Note |
|---|---|---|
| App shell: Tauri 2, one project | **Confirmed** for macOS, iOS (build + simulator) and Android (device). Windows **untested** | One `src-tauri` with desktop and mobile targets. `gen/android` and `gen/apple` are generated by `tauri android init` / `tauri ios init` |
| Language: TypeScript strict ESM | **Confirmed** | Shared ridrs code (`@ridrs/contracts`, `device-ftms-trainer`) bundled unchanged via Vite aliases |
| UI rendering: React | **Untested.** The spike used plain DOM on purpose | Nothing found against React. The brief still says Preact (see §10, D3) |
| UI build: Vite | **Confirmed** | Vite 8.3.5. `import.meta.glob` works (§4.2) |
| Core runs inside the WebView | **Partly confirmed** | Stage 2 reached on all three platforms tested; stage 3 (`@ridrs/core`) fails as is (§4.1) |
| BLE in apps: thin Rust Tauri plugin on btleplug | **Changed in detail** | Not a separate plugin crate: an app-local Rust module (≈280 lines) on top of **`tauri-plugin-blec` 0.18.0** (which wraps **btleplug 0.13.5**) |
| BLE headless: `transport-ble-noble` | **Unchanged**, not touched | |
| BLE in tests: simulator | **Unchanged** | The spike's adapter is tested against a fake Tauri IPC (Vitest) |
| Web Bluetooth: not used | **Confirmed** | Not used anywhere |
| Plugin loading in apps: bundled at build time | **Confirmed in a probe** (§4.2) | Needs explicit exclusion of Node-only plugins |
| Headless GUI via `ui-gateway-web` | **Untested**, out of the spike's scope | |

**Versions actually used** (from `Cargo.lock` / `package-lock.json`):

| Component | Version | License |
|---|---|---|
| `tauri` crate | 2.12.5 | Apache-2.0 OR MIT |
| `tauri-build` | 2.7.4 | Apache-2.0 OR MIT |
| `wry` (WebView layer) | 0.57.1 | Apache-2.0 OR MIT |
| `@tauri-apps/cli` / `@tauri-apps/api` | 2.12.4 | Apache-2.0 OR MIT |
| `tauri-plugin-blec` / `blec` | 0.18.0 | MIT OR Apache-2.0 |
| `btleplug` | 0.13.5 | MIT/Apache-2.0/BSD-3-Clause |

**Why `tauri-plugin-blec` (details: [FINDINGS §2](FINDINGS.md#2-ble-plugin-choice)):**

- **For it:** it is maintained and supports all four targets. On Android it ships its own Kotlin
  backend. btleplug's Android path needs hand-wired JNI, which would otherwise have to be rebuilt.
- **Against its own JS commands, which the spike does not use:** no service filter, no receive
  timestamp, bytes sent as JSON number arrays, and `expect()` panics in the notification path.
- **The spike's own layer** drives blec's Rust `Handler` directly. It adds exactly those three
  things (service filter, timestamps, binary frames) and contains no protocol logic.
- **Licenses:** MIT OR Apache-2.0 is in `LICENSING.md`'s preferred list, so it is compatible with
  AGPL-3.0-or-later. The transitive Rust tree contains 5 **MPL-2.0** crates via Tauri itself
  (`cssparser`, `selectors`, `dtoa-short`, `option-ext`, `cssparser-macros`). MPL-2.0 is not in the
  preferred list; see §10, D9 and [FINDINGS §6.5](FINDINGS.md#65-licenses-of-the-rust-dependency-tree).

---

## 4. First step of Phase 3, concretely

### 4.1 Runtime-neutral core

**Probe stage reached:** stage 2 on macOS, the iOS Simulator and Android (`device-ftms-trainer`,
unchanged, running in the WebView on `TauriBleCentral`). **Stage 3 ❌:**
- **As is:** importing anything from `@ridrs/core` in a browser bundle crashes at module load.
- **With measuring-only shims:** `EventBus` and `CapabilityRegistry` work (Chromium).

Details: [FINDINGS §5](FINDINGS.md#node-only-blockers-in-packagescore-confirmed-and-extended).

| Location | Node dependency | Why it blocks | Proposed port / change |
|---|---|---|---|
| `packages/core/src/event-bus.ts:3` (use `:83`) | `randomUUID` from `node:crypto` | Externalized by Vite, so `undefined` at runtime | No port: `globalThis.crypto.randomUUID()` (Node ≥ 19, all target WebViews). If tests need deterministic ids: inject `ids: () => string` like the clock |
| `packages/core/src/discovery.ts:3,4,6` (use `:24–28`, `:50–55`, `:86`) | `node:fs/promises`, `node:path`, `tinyglobby` | `tinyglobby` → `fdir` calls `createRequire` **at module load** and crashes | **`DiscoveryPort`** `discover(): Promise<{ location; manifestJson }[]>`. Filesystem adapter for headless, bundled adapter for apps. Validation and duplicate checks stay in the core |
| `packages/core/src/index.ts:6` | re-exports `discoverPlugins` | **Every** import of `@ridrs/core` loads `tinyglobby`; tree-shaking does not help | Move filesystem discovery to a Node-only entry (`@ridrs/core/node`, `apps/headless` or `packages/host-node`) |
| `packages/core/src/plugin-host.ts:3` (use `:372–373`) | `pathToFileURL` + `import(fileUrl)` | No file paths in a WebView | **`ModuleLoaderPort`** `load(location): Promise<PluginDefinition>`. File-URL adapter for headless, static-loader adapter for apps |
| `packages/core/src/plugin-host.ts:17` (use `:61`) | `pino` value import, default `pino({ level: 'silent' })` | Bundles (browser build) but couples the host to pino | **`LoggerPort`** `{ debug, info, warn, error, child }`. pino for headless, console for apps |
| `packages/contracts/src/plugin.ts:3`, `packages/core/src/diagnostics.ts:4` | `import type { Logger } from 'pino'` | Non-Node hosts must fake pino's full shape | Structural `PluginLogger` in contracts |
| `packages/core/src/plugin-host.ts:58,86` | `pluginsDir` → `discoverPlugins(…)` | Filesystem-shaped host API | `PluginHostOptions` takes `discovery` + `loader`; headless builds them from `pluginsDir`. Existing scenarios stay green |
| Brief §4.3 (new code) | `sessionId` via `node:crypto` | New blocker in `activity-session` | `globalThis.crypto.randomUUID()` |

Also observed: in this checkout `packages/core/node_modules` lacks links for `rxjs`, `pino` and
`tinyglobby`. That is workspace install state, not code. Run `pnpm install` first.

### 4.2 Bundled discovery: did `import.meta.glob` work?

**Yes**, in Vitest (Node) and in a browser build (Chromium). Probe: `src/probe/bundled-discovery.ts`;
details in [FINDINGS §5, "Bundled discovery"](FINDINGS.md#bundled-discovery-with-importmetaglob-probe).

```ts
const manifests = import.meta.glob<string>(
  ['../../plugins/*/manifest.json', '!../../plugins/transport-ble-noble/**'],
  { query: '?raw', import: 'default', eager: true },
);
const entries = import.meta.glob<{ default: PluginDefinition }>(
  ['../../plugins/*/index.ts', '!../../plugins/transport-ble-noble/**'],
);
```

**What worked:** manifests are read as strings and validated with the existing `parseManifestJson`,
so the manifest stays authoritative. Each entry becomes its own lazy chunk (`device-ftms-trainer`
7.8 kB, `metric-power` 1.5 kB, `metric-cadence` 1.5 kB); all three load in the browser.

**Limitations:**
1. Patterns must be **string literals**. The plugin set is fixed at build time.
2. **Node-only plugins must be excluded explicitly.** Without the exclusion the build still succeeds,
   but `@abandonware/noble` lands in a 51 kB chunk and loading `transport-ble-noble` fails at runtime
   (`TypeError: r.inherits is not a function`). So "select the plugin set like `--disable`" has two
   layers: a build-time exclusion for plugins that cannot load, plus the runtime disable list.
3. A glob over `*/manifest.json` cannot see folders without a manifest. `missing-manifest` has no
   bundled equivalent.
4. **`import.meta.glob` exists only under Vite/Vitest; Cucumber runs through `tsx`.** Make the bundled
   adapter take plain data, `createBundledDiscovery(manifests: Record<string, string>, loaders)`,
   call `import.meta.glob` only in `apps/native`, and let Cucumber feed in-memory records (§9).

### 4.3 `apps/native`: exact configuration

Values the spike used and verified, unless marked otherwise. Platform details:
[FINDINGS §6.2 iOS](FINDINGS.md#62-ios), [§6.3 Android](FINDINGS.md#63-android).

**`src-tauri/tauri.conf.json`**

| Key | Value | Why |
|---|---|---|
| `identifier` | e.g. `org.ridrs.app` (the spike used `org.ridrs.spike.ble`) | bundle id / package name |
| `version` | ≥ `"0.0.1"` | `tauri android build` refuses `0.0.0` |
| `build.devUrl` / `build.frontendDist` | `http://localhost:1420` / `../dist` | Vite dev server / output |
| `app.security.csp` | `null` in the spike | Assumption: Phase 3 should set a real CSP; not tested |
| `bundle.macOS.minimumSystemVersion` | `"11.0"` | |
| `bundle.macOS.entitlements` | `./Entitlements.plist` | see below |
| `bundle.iOS.minimumSystemVersion` | `"15.0"` | |
| `bundle.iOS.developmentTeam` | the Apple team id (10 characters, from the "Apple Development" certificate's OU) | automatic signing |
| `bundle.iOS.frameworks` | `["CoreBluetooth"]` | **Required.** Without it: link error `Undefined symbols: _CBAdvertisementDataLocalNameKey`. **Only applied when `gen/apple` is generated**: after changing it, `rm -rf src-tauri/gen/apple && tauri ios init` |
| `bundle.android.minSdkVersion` | `26` | resulting `targetSdk`/`compileSdk` 37 |

**`src-tauri/capabilities/default.json`:** `"permissions": ["core:default"]`, `"windows": ["main"]`.
App-local Rust commands need no extra permission (verified on all three platforms).

**`src-tauri/Info.plist`:** merged into **both** the macOS and the iOS app (verified in both bundles):

```xml
<key>NSBluetoothAlwaysUsageDescription</key>
<string>ridrs connects to your smart trainer, heart-rate strap and controllers over Bluetooth.</string>
```

No background modes; background BLE is a non-goal.

**Entitlements:** macOS `Entitlements.plist` sets `com.apple.security.device.bluetooth = true`. It only
matters with the App Sandbox, which the spike did not enable, so its effect is unverified. The
generated iOS entitlements file is an empty dict and worked.

**Android manifest:**
- blec's manifest is merged in automatically:
  - `BLUETOOTH` (`maxSdkVersion` 30), `BLUETOOTH_ADMIN`;
  - `ACCESS_FINE/COARSE_LOCATION` (**no** `maxSdkVersion`);
  - `BLUETOOTH_CONNECT`, and `BLUETOOTH_SCAN` with `neverForLocation`;
  - `uses-feature bluetooth_le required="true"`.
- On Android 17 only "Nearby devices" was requested; location stayed denied and scanning worked.
- Dropping location on Android ≥ 12 needs an override in `gen/android/app/src/main/AndroidManifest.xml`
  (`tools:node="replace"`, `android:maxSdkVersion="30"`). **Untested.**
- Build environment: `ANDROID_HOME`, `NDK_HOME` (NDK 28.2.13676358), `JAVA_HOME` (Android Studio JBR);
  Rust target `aarch64-linux-android`.

**Windows (untested):** build on Windows with the MSVC tools and WebView2. Assumption, from the
tech-stack doc §4.4: unpackaged builds need no capability; MSIX needs the `bluetooth` capability.

**Signing as done in the spike:**
- **macOS:** ad-hoc (linker-signed) local build.
- **iOS:** automatic signing (`xcodebuild -allowProvisioningUpdates`) with an "Apple Development"
  certificate plus `developmentTeam`. The simulator build (`--target aarch64-sim`) is unsigned. No
  distribution profile.
- **Android:** debug keystore; the release APK was left unsigned.
- **iOS tooling:** `xcodegen` (2.46.0) and CocoaPods must be installed.

### 4.4 `transport-ble-tauri`: how the contract maps onto the IPC

Contract: `packages/contracts/src/ble.ts`, unchanged. Rust commands as in the spike's `ble.rs`.

| Contract element | Mapping | Verified |
|---|---|---|
| UUIDs | `normalizeBleUuid` on every UUID crossing the boundary; Rust expands 4-hex short forms to the base UUID | unit tests (TS + Rust) |
| `scan({ serviceUuids, signal })` → `AsyncIterable` | `invoke('ble_scan', { serviceUuids, onEvent: Channel })`. JSON events `{ peripheralId, name, serviceUuids, rssi }` every 200 ms (blec polls). TS yields each `peripheralId` once. Abort **or** `break` → `ble_stop_scan`, iteration ends. Already aborted → no native call. The service filter is blec's, **client-side** | unit tests; real scans on macOS + Pixel 8 |
| `connect(id, { signal })` | `invoke('ble_connect', { peripheralId, onConnectionLost: Channel })`. Aborted before → `AbortError`, no call. Aborted during → disconnect, then `AbortError` | unit tests; real connect on Pixel 8 |
| `subscribe(target, cb)` → unsubscribe | `invoke('ble_subscribe', { …, onNotification: Channel })`. **Bytes:** `InvokeResponseBody::Raw`, which arrives as an **`ArrayBuffer`** on all 3 platforms. Frame: `u64 LE` monotonic µs, `f64 LE` wall ms, payload. Unsubscribe is idempotent, drops late frames, calls `ble_unsubscribe` | unit tests; real HR notifications |
| `onDisconnected(listener)` | blec's disconnect callback → `onConnectionLost` channel. Fires **at most once per connection object**; **suppressed after a user-initiated `disconnect()`** (blec reports both kinds) | unit tests only; real loss NV |
| `disconnect()` | `invoke('ble_disconnect', { peripheralId })` | unit tests |
| Timestamps | `receivedAt` stays the injected clock (as in Phase 2). Rust timestamps are for diagnostics and latency only | design |
| Id stability | Android: BLE address (identical across 3 launches). Apple: CoreBluetooth per-app UUID. Opaque. A device without a local name gets its id as `name` | Pixel 8 ✅, macOS ⚠️ |
| Reconnect without scan | Same process: blec reuses the known peripheral. New process: blec runs an internal short scan for the id, then connects (1813 ms on Pixel 8). Reconnect *policy* stays in TS (`p-retry`) | Pixel 8 (after restart) |
| Not in the contract | Android permission (`ble_check_permissions`; `true` elsewhere) and adapter state (`ble_adapter_state`: `On` / `Off` / `Unknown`). Called by the composition root, never by device plugins | Pixel 8, simulator |

**Known blec traps** (details: [FINDINGS §6.1](FINDINGS.md#6-observations-about-the-stack-not-fixed-here)):
- blec's scan task panics (`expect`) if its receiver is dropped early. Keep draining until blec closes it.
- Only one scan at a time: a new scan replaces the running one.

---

## 5. Reusable spike code

**Rule for every row:** reused code enters the workspace only behind failing Cucumber scenarios
first (AGENTS.md rule 1). The spike's Vitest tests (20, all green) can seed unit tests but do not
replace scenarios. Every new dependency needs an ADR (rule 2).

| Spike file | Target | Reuse | Why |
|---|---|---|---|
| `src/ble/tauri-ble-central.ts` | `plugins/transport-ble-tauri/` | **With changes** | Core mapping is right. Changes: provide `ble.central` via `definePlugin`/capability; drop `subscribeTimed`, `write`, `rssi` and `checkPermissions` from the public surface (not needed in Phase 3, §6); keep the abort/once-per-loss semantics |
| `src/ble/frame.ts` | `plugins/transport-ble-tauri/` | **As is** | Small, pure, tested decoder of the binary frame |
| `src/ble/ipc.ts` | `plugins/transport-ble-tauri/` | **As is** | The seam that makes the adapter testable without Tauri |
| `tests/fake-ipc.ts`, `tests/tauri-ble-central.test.ts` | `plugins/transport-ble-tauri/` unit tests + a fake for Cucumber | **With changes** | Becomes the "simulated Tauri bridge" for the scenarios in §9 |
| `src-tauri/src/ble.rs` | `apps/native/src-tauri/src/ble.rs` (or a crate, §10 D4) | **With changes** | Keep scan/connect/subscribe/unsubscribe/disconnect/permissions/adapter-state. Drop `spike_synthetic_notifications`, `ble_clock` and, until Phase 8, `ble_write`. Keep the cargo tests |
| `src-tauri/src/host.rs` | `apps/native/src-tauri/` | **Partly** | `keep_awake` only if D7 says yes. Packet log and selftest: not reusable (spike diagnostics) |
| `src-tauri/src/lib.rs`, `main.rs`, `build.rs`, `tauri.conf.json`, `Info.plist`, `Entitlements.plist`, `capabilities/` | `apps/native/src-tauri/` | **With changes** | Rename identifier/product. Keep the §4.3 keys. Regenerate `gen/` instead of copying it |
| `src/probe/bundled-discovery.ts` | Core `DiscoveryPort` + `apps/native` glob call | **With changes** | Split into a pure adapter that takes records and the glob call in `apps/native` (§4.2); add duplicate-id handling |
| `src/probe/ftms-plugin-probe.ts` | – | **Not reusable** | Hand-written plugin context; the real host replaces it once the core is runtime-neutral |
| `src/decoders/heart-rate.ts`, `ftms-control-point.ts`, `zwift-ride.ts` | future `device-heart-rate`, trainer control, controller plugin | **Not for Phase 3** | HR display and controller input are Phase 3 non-goals (brief §10); control point is Phase 8. Reusable later with changes |
| `src/main.ts`, `index.html`, `device-stats.ts`, `packet-log.ts`, `selftest.ts`, `clock-offset.ts`, `src/probe/core-entry.ts`, `src/probe/shims/*`, `vite.probe-*.config.ts` | – | **Not reusable** | Spike UI, measurement and probe code |

---

## 6. Contract findings, by the phase that needs them first

Details: [FINDINGS §7](FINDINGS.md#7-contract-gaps-ridrscontracts-blets). Phase 3 needs **no**
change to `ble.ts` types.

| Finding | Needed first by | Phase 3 action |
|---|---|---|
| `PluginLogger` is pino's `Logger` type | **Phase 3, first step** (runtime-neutral core) | Structural logger type in contracts (§4.1) |
| `onDisconnected` semantics (user vs. loss, once per connection object) unspecified | **Phase 3** (brief §8 manual check: "switch the trainer off → disconnected") | Document in `ble.ts` doc comments; no type change |
| Scan termination (may a transport end the iterable on its own?) | **Phase 3** (second transport implementation) | Document; no type change |
| Android runtime permission before scanning | **Phase 3** if Android is a Phase 3 target | Composition root of `apps/native`, not `ble.central` |
| `write(target, bytes, { withResponse })` | **Phase 8** (FTMS control point); also Zwift Ride's handshake (no phase planned) | none |
| Adapter state / "Bluetooth unavailable" (the simulator scan silently yields nothing) | First phase with device-status UI (not in the plan; brief §10 excludes a connection-status widget) | none; "no source" dashes are enough for Phase 3 |
| RSSI in scan results | First phase with device selection/pairing UI (brief §10 excludes it) | none |
| Transport receive timestamp | Assumption: Phase 4 (temporal data layer), if receive-time jitter matters there | none |
| Two subscriptions to the same characteristic (blec replaces the callback) | Phase 8 (control-point indications + data on the same device) at the earliest | none |

---

## 7. Platform caveats that affect the Phase 3 use case

Use case: "I start a ride and see my power and cadence."

| Caveat | Impact | Workaround | Brief must mention? |
|---|---|---|---|
| Core not WebView-ready (§4.1) | Nothing runs in `apps/native` | Ports first | **Yes** (first step) |
| `activity-session` `sessionId` via `node:crypto` (brief §4.3) | New blocker in a plugin that must run in the WebView | `globalThis.crypto.randomUUID()` | **Yes** |
| Android needs a runtime "Nearby devices" grant before scanning | Without it no trainer is found. Assumption: the scan would fail or stay empty (the deny flow was not tested) | `apps/native` composition root requests the permission before starting the host | **Yes** |
| iOS link needs `bundle.iOS.frameworks: ["CoreBluetooth"]`, only applied at `ios init` | iOS build fails | Config key + regenerate `gen/apple` | **Yes** (config) |
| Screen sleeps during a ride (no input while pedalling) | Display turns off mid-ride | Screen Wake Lock API (available in Android WebView and WKWebView in the simulator; on a real iPhone NV) plus `keepawake` crate 0.6.1 (MIT) on desktop | Decision D7 |
| `import.meta.glob` needs explicit exclusion of `transport-ble-noble` | Silent 51 kB bloat and a runtime load failure if the noble plugin is started | Negative glob patterns | **Yes** |
| No end-to-end automation for `apps/native` | Tauri's WebDriver does not cover all targets (tech-stack §8), so the brief's Playwright approach does not apply to the app | Cucumber for logic in Node; manual checklist per platform; `@browser` stays for the browser variant | **Yes** |
| Minor; no brief change needed | The first scan after launch can take seconds (macOS: first result after 210–4748 ms). Without Bluetooth a scan yields nothing and no error, so widgets show "no source", same as "no trainer". blec's `uses-feature bluetooth_le required="true"` hides the app from devices without BLE | none needed | No |

---

## 8. Not verified

| Item | What is needed to verify it | Can Phase 3 start without it? |
|---|---|---|
| **FTMS Indoor Bike Data on hardware** (power/cadence, ≈4 Hz, 30 min without gaps > 1 s), any platform | FTMS trainer (e.g. KICKR CORE) and the spike app ("Scan FTMS" → Connect), 30 min ride per platform | **Yes**: the simulator covers automation; the brief's DoD already allows "state that the hardware check could not be performed" |
| **Connection-lost detection time and in-process reconnect** | Switch the trainer off/on while connected; read "last loss" and the reconnect count in the spike UI | **Yes** (implemented and unit-tested; Phase 2 policy unchanged) |
| **FTMS control-point write + indication** | Trainer; spike buttons "Request control" / "Set target power 150 W" | **Yes**: not needed before Phase 8 |
| **Zwift Ride** (handshake write, 4 simultaneous connections) | Zwift Ride controllers + trainer + HR | **Yes**: not needed by any planned phase |
| **iPhone on a device** (permission prompt, scan, connect, notify, reconnect) | Connected unlocked iPhone; `npx tauri ios dev` in the spike | **First step: yes.** Declaring `apps/native` the iOS target: no (gate 1, D1) |
| **Windows** (everything) | Windows 10/11 PC with BLE, MSVC; `npx tauri build` + spike checks | **First step: yes.** A Windows target for Phase 3: no |
| macOS connect/notify (only scanned) | Any BLE peripheral; the spike app | Yes |
| Permission **denied / granted-later** flows (all platforms) | Deny the prompt, re-grant in settings | Yes |
| Screen lock / background 2 min | Device + trainer; the spike UI records the timer interval and visibility | Yes (decide D7) |
| Android **release** build latency and cold start (only debug measured: p95 23 ms, 2395 ms) | Signed release APK on Pixel 8 | Yes |
| iOS release IPA size; stage 3 inside a real WebView (only Chromium); React in the WebViews | Distribution profile; the ports; a React build | Yes |

---

## 9. Proposed changes to the Phase 3 brief

All proposals. **Nothing has been changed outside `experiments/tauri-ble-spike/`.**

| Brief § | Current | Proposal |
|---|---|---|
| 0 (table, scope) | Phase 3 = activity & GUI as plugins | Add: "first step: runtime-neutral core, bundled discovery, `apps/native` skeleton, `transport-ble-tauri`" |
| 1.3 | Maintainer decision on GUI delivery + framework required | Reference D2/D3 of this handover; keep the stop rule |
| 2 (objective, diagram) | Headless app + browser via `ui-gateway-web` | Main composition root `apps/native` with an **in-process** UI bridge; the diagram's `ui-gateway-web` box becomes optional (D2) |
| 2.1 "Superseded direction" box | Pending the spike | Replace with: "spike result: provisional go (see HANDOVER); gates: iPhone, trainer, Windows" |
| 3 (libraries) | hono, ws, preact, playwright, happy-dom, p-event | Add (all AGPL-compatible per `LICENSING.md`): `@tauri-apps/api` + `@tauri-apps/cli` 2.12.x and crate `tauri` 2.12.x (Apache-2.0 OR MIT); `tauri-plugin-blec` 0.18.0 (MIT OR Apache-2.0); `keepawake` 0.6.1 (MIT) if D7; React (MIT) if D3. hono/ws/playwright only if the browser variant stays (D2). Drop "Do not add … Tauri" |
| 4 (contracts) | `packages/contracts` browser-safe | Add: `PluginLogger` structural (§4.1); doc comments for `onDisconnected` and scan termination; no `ble.ts` type change |
| 4.2 | Registry rule `client-entry-missing`: "`ui.client` does not exist **on disk**" | For bundled discovery: "is not part of the bundled plugin set" (same code) |
| 4.3 | `sessionId` via `node:crypto` | `globalThis.crypto.randomUUID()` |
| 5.3 | `ui-gateway-web` required | Optional headless add-on, or a later phase (D2) |
| 6 (depcruise) | Browser code must not import `node:*` … | Add: `packages/core` and `packages/contracts` import no `node:*`; only `plugins/transport-ble-tauri` and `apps/native` import `@tauri-apps/*`; `apps/native` imports plugins only through bundled discovery |
| 7 (test harness) | Playwright for `@browser` | Add: bundled discovery and `transport-ble-tauri` run in Cucumber against in-memory data / a simulated Tauri bridge; `import.meta.glob` itself only in `apps/native` (Vitest smoke test) |
| 8 (vertical use case) | `pnpm --filter @ridrs/headless start` + browser | Add: `pnpm --filter @ridrs/native tauri dev` (macOS) / `tauri android dev`; manual hardware check per available platform |
| 9 (spec) | five feature files | Add the first-step features below; keep all existing scenarios |
| 10 (non-goals) | "No Electron/Tauri/mobile packaging" | Remove for Tauri; keep "no store submission, no auto-update, no background BLE" |
| 11 (strategy) | starts with contracts | Insert step 0: ports + headless adapters (all Phase 1/2 scenarios green) → bundled discovery → `transport-ble-tauri` → `apps/native` skeleton |
| 12 (DoD) | headless + browser | Add: `apps/native` builds for macOS and Android (D6); the pipeline still runs without Rust/Xcode/Android SDK (tech-stack §7) |

### Draft Gherkin for the first step (proposal)

It reuses Phase 1/2 steps verbatim where possible. New steps are marked `# new`.

```gherkin
# PROPOSAL – tests/features/core/bundled-discovery.feature
@phase-3
Feature: Plugin discovery from a bundled plugin set
  Apps cannot read a plugin directory. They discover plugins from a set bundled at build time.
  The manifest stays the single source of truth; only the way manifests are found differs.

  Scenario: Every bundled plugin with a valid manifest becomes a known plugin
    Given a bundled plugin set containing:                       # new (same table as Phase 1)
      | folder    | id        | types             | provides | requires |
      | example-a | example-a | example           |          |          |
      | example-b | example-b | example, listener |          |          |
    When the host discovers the bundled plugins                  # new
    Then the known plugins are "example-a, example-b"
    And the plugin "example-b" has the types "example, listener"
    And the discovery reported no problems

  Scenario: An invalid bundled manifest is reported with the offending field and skipped
    Given a bundled plugin set containing:
      | folder    | id        | types   | provides | requires |
      | example-a | example-a | example |          |          |
    And the bundled plugin set contains a folder "broken" with the manifest '{"name":"Broken","version":"1.0.0","types":["example"],"provides":[],"requires":[],"entry":"index.ts"}'   # new
    When the host discovers the bundled plugins
    Then the known plugins are "example-a"
    And the discovery reported an "invalid-manifest" problem for folder "broken" mentioning "id"

  Scenario: A manifest whose entry is not part of the bundle is reported
    Given a bundled plugin set containing:
      | folder | id    | types   | provides | requires |
      | ghost  | ghost | example |          |          |
    And the entry module of "ghost" is not part of the bundle    # new
    When the host starts
    Then the host reported an "entry-load-failure" problem for plugin "ghost"
    And the plugin "ghost" is in the state "failed"
```

```gherkin
# PROPOSAL – tests/features/devices/trainer-connection-tauri.feature
@phase-3
Feature: The FTMS trainer over the Tauri BLE transport
  The unchanged device plugin works on top of transport-ble-tauri, driven through a simulated
  Tauri bridge instead of the native app.

  Background:
    Given the host clock shows "10:00:00.000"
    And a simulated Tauri bridge with an FTMS trainer "KICKR CORE 1234"   # new
    And the ridrs plugins "transport-ble-tauri, device-ftms-trainer, metric-power, metric-cadence" running   # new

  Scenario: Power arrives through the Tauri transport
    Given the trainer "KICKR CORE 1234" is connected
    When the trainer sends the Indoor Bike Data packet "45 00 B4 00 C8 00"
    Then the latest "metric.power" is 200 W from the trainer "KICKR CORE 1234" measured at "10:00:00.000"

  Scenario: A lost connection is reported once and the trainer is reconnected by its id
    Given the trainer "KICKR CORE 1234" is connected
    When the trainer "KICKR CORE 1234" drops the connection and refuses new connections
    Then the connection state of "KICKR CORE 1234" is "reconnecting"
    When the trainer "KICKR CORE 1234" accepts connections again
    And 1 second passes
    Then the connection state of "KICKR CORE 1234" is "connected"
    And the simulated Tauri bridge received no new scan request   # new
```

Runtime neutrality itself is enforced by dependency-cruiser (no `node:*` in `packages/core` and
`packages/contracts`), not by Gherkin. The existing `plugin-discovery.feature` and
`headless*.feature` must stay green **unchanged**: they prove the filesystem adapter behaves exactly
as before.

---

## 10. Maintainer decisions

**Decided by the maintainer on 2026-11-01: every recommendation below was accepted (D1–D11).**

- **D1:** start the Node-side first step now.
- **D2:** `apps/native` is the only Phase 3 GUI root; `ui-gateway-web` moves to a later phase.
- **D3:** React.
- **D4/D5:** app-local `ble.rs` on `tauri-plugin-blec`.
- **D6:** the definition of done covers macOS and Android; iOS is build-only until the iPhone gate
  closes; Windows when hardware is available.
- **D7:** minimal keep-awake.
- **D8:** override the location permission.
- **D9:** MPL-2.0 approved.
- **D10:** no `ble.ts` type changes.
- **D11:** Phase 2 and the spike are committed separately before Phase 3.

The Phase 3 brief still has to be revised accordingly (§9); until then this section takes precedence
over the brief where they conflict.

| # | Question | Recommendation | Alternative |
|---|---|---|---|
| D1 | Start Phase 3's first step before the three gates (iPhone, trainer, Windows) are closed? | **Yes.** The first step is needed in every §9 outcome. Close gate 1 (iPhone) before `apps/native` becomes the main composition root | Wait until the spike is complete (1–2 days with hardware) |
| D2 | Main GUI composition root in Phase 3 | **`apps/native` with an in-process UI bridge**; move `ui-gateway-web` to a later phase as a headless add-on (smaller Phase 3) | Build both: `apps/native` and `ui-gateway-web` + browser (brief as written + the first step) |
| D3 | UI framework | **React (MIT)**, as in the tech-stack doc (keeps `react-three-fiber` open for later). The client contract stays framework-neutral | Preact (MIT), as in the brief (smaller per-plugin bundles) |
| D4 | Where the Rust BLE layer lives | **App-local module `apps/native/src-tauri/src/ble.rs`** (≈280 lines, one consumer) | Separate crate `crates/tauri-plugin-ridrs-ble` (tech-stack §6) |
| D5 | BLE backend | **Keep `tauri-plugin-blec` 0.18.0** for platform backends (its Android backend is the main value); bypass its JS commands | Own Tauri plugin directly on btleplug 0.13.5 (rebuild Android JNI) |
| D6 | Which platforms must Phase 3's DoD cover? | **macOS and Android built and manually checked; iOS build-only until gate 1; Windows "when hardware is available"** | All four required |
| D7 | Keep-awake during a ride in Phase 3? | **Yes, minimal:** Screen Wake Lock API in the `apps/native` shell while a ride runs, `keepawake` 0.6.1 (MIT) on desktop. The use case breaks after the screen timeout otherwise | Defer; document "disable auto-lock" for manual checks |
| D8 | Android location permission declared by blec | **Override it** (`maxSdkVersion="30"`) in `apps/native` and verify on a device | Accept the declaration (runtime did not ask for it on Android 17) |
| D9 | Transitive MPL-2.0 crates via Tauri (`cssparser`, `selectors`, `dtoa-short`, `option-ext`, `cssparser-macros`) and `lightningcss` (MPL-2.0, Vite build-time only); MPL-2.0 is not in `LICENSING.md`'s preferred list | **Approve.** MPL-2.0 §3.3 allows combination with (A)GPL; list them in `NOTICE` | Reject, which rules out Tauri itself |
| D10 | Changes to `ble.ts` types in Phase 3 | **None.** Only doc comments (`onDisconnected`, scan termination); `write` comes in Phase 8 with scenarios | Add `write` and `rssi` now (speculative under AGENTS.md rule 3) |
| D11 | Commit order (Phase 2 is still uncommitted in the working tree) | **Commit Phase 2 first, then the spike folder as its own commit**, so Phase 3 starts from a clean base | One combined commit |
