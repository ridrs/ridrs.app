<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# Findings: Tauri 2 + native BLE spike

**Question:** can ridrs ship native apps for Windows, macOS, iOS and Android from one TypeScript code
base with Tauri 2, using native Bluetooth LE through a thin Rust plugin, reliably enough for indoor cycling?

**Short answer (2026-11-01):**
- **Builds:** the single-project build chain works on macOS, iOS and Android.
- **macOS:** the whole software path works end to end: JS → Rust → CoreBluetooth scan → Rust →
  binary IPC channel → JS. The real `device-ftms-trainer` plugin also runs inside WKWebView.
- **iOS Simulator:** the app installs and starts, and stage 2 runs. The simulator has no Bluetooth,
  so no BLE result.
- **Real BLE on Android (Pixel 8, Android 17):**
  - The "Nearby devices" permission flow works without location being requested.
  - The service-filtered scan works without a picker.
  - A heart-rate device connected and notified live through the full chain.
  - Reconnect by remembered id after an app restart works.

**Still open:** the trainer checks (FTMS data, ≈4 Hz stability, connection-lost, control point),
Windows, and a real iPhone. No trainer, Windows PC or connected iPhone was available. Under section
7 of the brief the go/no-go decision therefore stays **open**. Every cell below that needs hardware
we did not have says so instead of guessing.

## 1. Environment

| Item | Value |
|---|---|
| Build host | MacBook Pro `Mac15,7` (Apple M3 Pro), macOS 26.7.1 (25G241), built-in Bluetooth BCM_4388 |
| Toolchains | Node 26.10.0, npm 11, Rust 1.99.1 (Homebrew `rustup`, installed for the spike), Xcode 26.3 (17C529), iPhoneOS SDK 26.2, xcodegen 2.46.0, CocoaPods 1.16.2, Android SDK platforms 36/37, NDK 28.2.13676358, JDK 25 (Android Studio JBR) |
| Tauri | `tauri` 2.12.5, `@tauri-apps/cli` / `@tauri-apps/api` 2.12.4 |
| BLE stack | `tauri-plugin-blec` 0.18.0 → `blec` 0.18.0 → `btleplug` 0.13.5 (desktop/iOS); blec's own Kotlin backend (Android) |
| Windows PC | **not available** |
| iPhone | iPhone 16 Pro (iPhone17,1) is paired with the Mac but showed as `unavailable` (not connected) for the whole session |
| iOS Simulator | iPhone 17 Pro, iOS 26.3 (no Bluetooth in the simulator; WKWebView UA reports iPhone OS 18_7) |
| Android phone | **Pixel 8**, Android 17 (API 37), Android System WebView 156.0.8078.47, wireless ADB, debug APK |
| Android emulator | `Pixel_8a` AVD, Android 17 (API 37), WebView 153.0.8010.36, virtual Bluetooth on, nothing advertising |
| BLE peripherals | Xiaomi Smart Band 10 (advertises and serves the heart-rate service `0x180D`); a "TRACKR HR" also seen in HR scans |
| FTMS trainer, chest HR strap, Zwift Ride | **not available** |

## 2. BLE plugin choice

**Decision:** keep `tauri-plugin-blec` for the platform backends and initialization, but do **not**
use its JS commands. A thin app-local command layer (`src-tauri/src/ble.rs`, about 280 lines with
tests) drives blec's `Handler` directly.

Evaluation of `tauri-plugin-blec` 0.18.0 against brief section 4.1:

| Criterion | Result |
|---|---|
| Maintained | Yes. 0.18.0 is current; the crate was split into `blec` + Tauri layer recently; multi-device support landed in 0.18 |
| License | MIT OR Apache-2.0: compatible with an AGPL-3.0-or-later consumer |
| All four platforms | Yes on paper: btleplug for Windows/macOS/iOS, its own Kotlin module for Android (btleplug's Android support needs a hand-wired JNI/`droidplug` setup, which blec replaces) |
| Notify **and** write | Yes (`subscribe_to`, `send_data_to` with/without response) |
| Scan without picker | Yes |
| Service-UUID scan filter | Supported by `blec::Handler::discover` (`ScanFilter::AnyService`), **but the JS `scan` command hard-codes `ScanFilter::None`** |
| Rust-side receive timestamp | **Missing.** Notifications are bare `Vec<u8>` |
| Efficient bytes over IPC | **No.** `Channel<Vec<u8>>` is serialized as a JSON number array |
| Robustness of the JS command path | **Weak.** `subscribe` uses `try_send(..).expect(..)` inside the notification callback, which panics when its 512-slot buffer fills. `on_data.send(..).expect(..)` panics when the JS side is gone. It also logs every packet at `info!` |

The own layer adds exactly the three missing pieces: service filter, timestamps, binary frames. It
interprets no payloads. Writing a plugin directly on btleplug instead would have meant
re-implementing blec's Android backend. For a spike that cost is not justified, and Android is the
platform where blec adds the most value.

**Rust surface (`ble.rs`):** `ble_scan(serviceUuids, onEvent)`, `ble_stop_scan`,
`ble_connect(peripheralId, onConnectionLost)`, `ble_disconnect`,
`ble_subscribe(peripheralId, service, characteristic, onNotification)`, `ble_unsubscribe`,
`ble_write(…, data, withResponse)`, `ble_check_permissions`, plus `ble_clock` and
`spike_synthetic_notifications`, which are measurement only.

**IPC encoding:**
- Notifications travel as `tauri::ipc::InvokeResponseBody::Raw` over a `Channel`. They arrive in JS
  as an **`ArrayBuffer`** (verified on macOS, iOS Simulator, Android emulator and Pixel 8: 1120 of
  1120 synthetic frames on each, and the real HR notifications on the Pixel 8).
- Frame layout: `u64 LE` monotonic µs since process start, then `f64 LE` wall-clock ms, then the
  payload (16-byte header).
- Scan events and connection-lost events are JSON over a `Channel`.
- Writes go as a JSON number array. That is acceptable for control-point traffic.

## 3. Results matrix (brief section 5)

✅ works · ⚠️ works with caveats · ❌ fails · **NV** not verified (with reason) · n/a

| # | Check | Win | macOS | iOS | Android |
|---|---|---|---|---|---|
"Sim" = iOS Simulator (no Bluetooth). "Emu" = Android emulator. Android results without a prefix
are from the real Pixel 8.

| # | Check | Win | macOS | iOS | Android |
|---|---|---|---|---|---|
| 1 | Builds, installs, starts from the single project | NV: no Windows host (cross-build not attempted) | ✅ release `.app` builds and starts (ad-hoc signed) | ⚠️ debug `.ipa` for device builds and is signed with a development team (CoreBluetooth must be linked, see 6.2). **Sim: installs and starts ✅.** Device install NV: iPhone not connected | ✅ debug APK installs and starts on the **Pixel 8** and Emu. Release APK builds (unsigned, not installed) |
| 2 | Clean permission flow | NV | ⚠️ `NSBluetoothAlwaysUsageDescription` merged from `src-tauri/Info.plist`. Bluetooth access was in place (scan returned devices). The first-run prompt and the denied/granted-later flows were not exercised | ⚠️ the key is in the IPA's `Info.plist` (verified). The simulator reports permission `true` and adapter state `Unknown`. Device prompt NV | ⚠️ the "Nearby devices" runtime grant (`BLUETOOTH_SCAN` + `BLUETOOTH_CONNECT`, both `USER_SET`) was accepted on Pixel 8 and Emu. **Location was never requested and stays `granted=false`**; scanning works without it. The manifest still declares location (blec, 6.3). Denied/granted-later NV |
| 3 | Scan finds the trainer without a system picker | NV | ⚠️ no picker; the unfiltered scan finds 18–31 nearby peripherals in 8 s. No trainer to find | NV: Sim has no Bluetooth (scan yields nothing **and no error**, see 7) | ⚠️ no picker. Unfiltered: **50 peripherals in 8 s, first after 275 ms**. No trainer to find |
| 4 | Scan filtered by service UUID | NV | ⚠️ filter path runs (FTMS filter: 0 results, unfiltered: all). Positive match NV without an FTMS device. Filtering is client-side in blec (6.1) | NV | ✅ HR filter `180d` returned exactly the two HR devices (Xiaomi Smart Band 10, TRACKR HR) out of ~50 nearby. FTMS filter: 0 (no trainer) |
| 5 | FTMS Indoor Bike Data, power/cadence via the real parser | NV | NV: no trainer. The parser path is covered by the stage 2 test with a synthetic packet | NV | NV: no trainer |
| 6 | ≈4 Hz, no gaps > 1 s over 30 min | NV | NV: no trainer. The channel path delivered 120/120 synthetic frames at 4 Hz and 1000/1000 at 200 Hz | NV. Sim: 1120/1120 synthetic frames | NV: no trainer. The HR band notified 36 times in 56 s (interval 778–2046 ms, median 1994 ms: the band's own rate, so the > 1 s gap counter does not apply to it). 1120/1120 synthetic frames |
| 7 | HR strap in parallel with the trainer | NV | NV | NV | ⚠️ HR device (Xiaomi Smart Band 10) connects (1429 ms) and notifies live (58–61 bpm) through the full chain, **while an unfiltered scan ran in parallel**. In parallel with a trainer NV |
| 8 | Trainer off → `connection-lost` within 5 s | NV | NV (implemented: blec's `OnDisconnectHandler` → channel → `onDisconnected`, once per loss, unit-tested) | NV | NV: the band could not be switched off on demand; toggling the phone's Bluetooth was not done (system setting) |
| 9 | Trainer on → reconnect by remembered id, no new scan | NV | NV. In the same process blec reuses its known peripheral; **after an app restart blec runs an internal short scan before connecting** (6.1) | NV | ⚠️ after force-stopping and relaunching the app, **"Connect by id" connected the HR band in 1813 ms** without a user-started scan (blec's internal short scan included) and notifications resumed. After a peripheral power cycle NV |
| 10 | Peripheral id stable across restarts | NV | ⚠️ ids are CoreBluetooth per-app UUIDs (blec uses `peripheral.id()` on Apple). A named static-address device (LG TV) kept id `2964592f…` across 4 app launches. Devices with rotating private addresses did not reappear under the same id (expected). No trainer was used | NV | ✅ id is the BLE address (`F1:F2:28:24:62:40`, a random static address), identical across 3 app launches |
| 11 | FTMS control point: request control + target power, indication | NV | NV: no trainer (encoding/decoding unit-tested) | NV | NV: no trainer |
| 12 | Zwift Ride: handshake write + 4 connections | NV | NV: no hardware. Note: in `zwift-packet-capture.log` LEFT and RIGHT have the **same** device id, which suggests a single BLE peripheral for both controllers | NV | NV |
| 13 | Screen lock / background 2 min | NV | NV (UI records worst 1 s-timer interval and visibility changes for this test) | NV | NV. While connected, keep-awake used the **Screen Wake Lock API** (available in Android WebView and in WKWebView on the Sim) |
| 14 | Real ridrs code: stage reached | NV | **Stage 2** in WKWebView. **Stage 3** only with measuring shims (Chromium, browser pane) | **Stage 2** in WKWebView (Sim) | **Stage 2** in Android System WebView (Pixel 8 and Emu) |
| 15 | IPC latency Rust receive → JS handler | NV | ⚠️ synthetic frames over the real path: median **0.79 ms**, p95 **1.36 ms**, max 1.58 ms at 4 Hz (n=120); median **0.48 ms**, p95 **0.98 ms**, max 2.45 ms at 200 Hz (n=1000). 1 ms timer resolution, see 4 | ⚠️ Sim, synthetic: median 0.74 ms, p95 1.58 ms at 4 Hz; median 0.74 ms, p95 1.25 ms at 200 Hz (debug build) | ⚠️ **real HR notifications: median 3.49 ms, p95 23.12 ms (n=36)**. Synthetic: median 5.90 ms, p95 20.61 ms, max 37.9 ms at 4 Hz; median 2.27 ms, p95 4.17 ms at 200 Hz. **Debug build** (unoptimized Rust); release NV |
| 16 | Packaged size; cold start | NV | `.app` **5.3 MiB** (release, arm64); cold start **399–533 ms** (Rust process start → first JS IPC call, 5 launches) | debug `.ipa` 18.6 MB (release NV: no distribution profile set up). Sim cold start 964–1584 ms (debug) | release APK arm64 unsigned **8.3 MB**; debug universal APK 168.6 MB (unstripped). Cold start, debug: **Pixel 8 2395 ms** (first launch after install), Emu 445 ms |
| 17 | Build friction | NV | Low: `npx tauri build`. Rust had to be installed | Medium: `xcodegen` needed; team id in `tauri.conf.json`; `CoreBluetooth` only via `bundle.iOS.frameworks` and only honored when `gen/apple` is generated (6.2). Sim build: `--target aarch64-sim` | Medium: `ANDROID_HOME`, `NDK_HOME`, `JAVA_HOME` must be exported; `version` must be ≥ `0.0.1`; first build 2 min 15 s. Install over wireless ADB worked without extra steps |

**Must-pass status (section 5):** 1, 2, 3, 5, 6, 8, 9 and 11 on all four platforms, plus 14 at least
at stage 2 on all four. Shown so far:

| Platform | Shown | Open |
|---|---|---|
| macOS | 1, 14 (stage 2) | 2, 3, 5, 6, 8, 9, 11 |
| iOS | 1 (simulator only), 14 (stage 2) | 2, 3, 5, 6, 8, 9, 11 (simulator has no Bluetooth) |
| Android | 1, 14 (stage 2), and 2, 3, 9 with caveats (the caveat on 3 and 9 is no trainer, using an HR device instead) | 5, 6, 8, 11 |
| Windows | – | everything |

## 4. Measurements

All on the build host above, release build, app window in the foreground unless noted.

| Measurement | Value | Conditions |
|---|---|---|
| `invoke` round trip (`ble_clock`, sync command) | mean **0.18 ms** (n=1000; three runs: 0.181–0.184 ms) | median 0 ms / p95 1 ms only reflect WebKit's 1 ms timer coarsening |
| Rust → JS notification latency (synthetic, same channel/frame path as BLE) | 4 Hz: median 0.79 ms, p95 1.36 ms, max 1.58 ms. 200 Hz: median 0.48 ms, p95 0.98 ms, max 2.45 ms | Rust wall clock in the frame vs JS `timeOrigin + performance.now()`, corrected by an NTP-style offset (0.94–1.22 ms) from the minimum-RTT `ble_clock` sample. Resolution ±1 ms. Without the correction the raw difference was negative |
| Frames lost on the channel | 0 of 1120 | 120 @ 250 ms + 1000 @ 5 ms |
| Unfiltered scan | 18 / 20 / 27 / 31 peripherals in 8 s, first result after 4748 / 2976 / 2818 / 210 ms | blec polls `adapter.peripherals()` every 200 ms. The long first-result times all occurred in the first scan after launch |
| Cold start | 533 ms (first launch), 403, 427, 399 ms | Rust `run()` entry → first JS IPC call, release |
| Packaged size | macOS `.app` 5.3 MiB; Android release APK arm64 8.3 MB (unsigned); iOS debug IPA 18.6 MB | |
| WebView bundle | 145.7 kB JS (42.6 kB gzip) incl. contracts, zod, parser, `device-ftms-trainer`, p-retry, `@tauri-apps/api` | `vite build`, es2022 |
| Core bundle (stage 3) | plain 197 kB (fails at load); shimmed 161 kB (runs) | `vite.probe-core.config.ts` |

### Mobile (debug builds, selftest via `selftest.flag` / `SIMCTL_CHILD_RIDRS_SPIKE_SELFTEST=1`)

| Measurement | iOS Simulator (iPhone 17 Pro) | Android emulator (Pixel_8a) | Pixel 8 (real) |
|---|---|---|---|
| `invoke` round trip, mean (n=1000) | 0.26 / 0.35 ms | 0.70 ms (median 0.6, p95 1.2) | 1.50 ms (median 1.3, p95 2.6) |
| Synthetic 4 Hz, Rust → JS median / p95 / max | 0.93 / 1.85 / 2.75 ms; 0.74 / 1.58 / 2.67 ms | 1.30 / 2.75 / 14.0 ms | 5.90 / 20.61 / 37.9 ms |
| Synthetic 200 Hz, median / p95 / max | 0.94 / 1.49 / 3.28 ms; 0.74 / 1.25 / 4.77 ms | 0.74 / 2.06 / 2.82 ms | 2.27 / 4.17 / 17.7 ms |
| Real BLE notifications, median / p95 | – | – | 3.49 / 23.12 ms (n=36, HR band) |
| Frames lost | 0 / 1120 | 0 / 1120 | 0 / 1120 |
| Adapter state | `Unknown` | `On` | `On` |
| Unfiltered scan, 8 s | 0 (no Bluetooth) | 0 (nothing advertising) | 50, first after 275 ms |
| Connect (HR band) | – | – | 1429 ms (after scan), 1813 ms (by id after restart) |
| Cold start | 1584 / 964 ms | 445 ms | 2395 ms (first launch after install) |
| Screen Wake Lock API | available | available | available, used while connected |
| Android clock offset (Rust − JS) | – | −0.05 / −0.10 ms | −0.15 ms (Chromium's clock is sub-ms, unlike WebKit) |

The low-rate latency tail on the Pixel 8 (p95 ≈ 20 ms at 4 Hz, against 4 ms at 200 Hz) points at CPU
or WebView wake-up from idle between notifications. It should be re-measured with a release build
before drawing conclusions. ±20 ms is still far below the 250 ms trainer interval.

## 5. Real ridrs code in the WebView (brief 4.4)

| Stage | Result |
|---|---|
| 1. `@ridrs/contracts` + `parser.ts` | ✅ bundles and runs in WKWebView with **no shims**. contracts only needs zod, semver and a type-only pino import |
| 2. `device-ftms-trainer/index.ts` with a hand-written context and `ble.central` = `TauriBleCentral` | ✅ bundles unchanged (incl. `p-retry`). Runs **inside the macOS app, the iOS Simulator app and the Android app (Pixel 8, emulator)**: the selftest started it, it published `device.connection-changed` (`searching`), scanned through the real Rust chain and stopped cleanly. In Node (Vitest + fake IPC) it goes all the way to `measurement.power` / `measurement.cadence` |
| 3. `@ridrs/core` | ❌ as is. ⚠️ with measuring-only shims (see below) |

### Node-only blockers in `packages/core` (confirmed and extended)

The brief's table lists three files. `prompts/tech-stack-ui-and-bluetooth.md` §5 lists four (adds
logging/pino), which explains the "four blockers" wording in brief §9.

| # | File | Status | Detail |
|---|---|---|---|
| 1 | `event-bus.ts`: `node:crypto` `randomUUID` | **Confirmed, trivial** | Vite externalizes it, so the import is `undefined` at runtime. A 1-line shim to `globalThis.crypto.randomUUID()` made the EventBus deliver events in the browser |
| 2 | `discovery.ts`: `node:fs/promises`, `node:path`, `tinyglobby` | **Confirmed, and worse than listed** | `tinyglobby` → `fdir` calls `createRequire` from `node:module` **at module load**. Because `core/src/index.ts` re-exports `discoverPlugins`, importing **anything** from `@ridrs/core` crashes (`TypeError: createRequire is not a function`) before core code runs. Tree-shaking does not help |
| 3 | `plugin-host.ts`: `node:url` `pathToFileURL` + dynamic `import()` of entry paths | **Confirmed** | Shimmed only to get past bundling. `PluginHost` cannot be used in a WebView until module loading is a port |
| 4 | pino (`plugin-host.ts` default logger, `diagnostics.ts`, `PluginLogger` type in contracts) | **Confirmed as a coupling, not a bundling blocker** | Vite picks pino's browser build, so it bundles. But `PluginLogger` is pino's `Logger` type, so every non-Node host must fake a pino-shaped object (the probe does a cast) |

**Also observed:** `packages/core/node_modules` in this checkout has no links for `rxjs`, `pino`,
`tinyglobby` (only `dependency-graph`), so the stage 3 probe aliases them to the spike's own copies.
This is workspace install state (the lockfile is modified and uncommitted), not a code defect.

### Bundled discovery with `import.meta.glob` (probe)

Probe: `src/probe/bundled-discovery.ts`, test `tests/bundled-discovery.test.ts`, browser build
`vite.probe-discovery.config.ts`. Results:

- **Works in Node (Vitest) and in the browser** (Chromium, built bundle). The probe uses two globs:
  - `import.meta.glob('…/plugins/*/manifest.json', { query: '?raw', import: 'default', eager: true })`
    reads every manifest as a string; each is validated with the existing `parseManifestJson`.
  - `import.meta.glob('…/plugins/*/index.ts')` gives one lazy loader per entry. Each plugin becomes
    its own chunk (`device-ftms-trainer` 7.8 kB, `metric-power` 1.5 kB, `metric-cadence` 1.5 kB),
    loaded on demand. All three loaded and exposed `start`.
- **Globs are static.** Patterns must be literal strings, relative to the importing file (or
  root-absolute). The plugin set is fixed at build time; a manifest `entry` pointing outside the
  glob is not bundled. The probe reports this as `entry-not-bundled`.
- **Node-only plugins must be excluded explicitly**, with negative patterns
  (`'!…/plugins/transport-ble-noble/**'`). Without the exclusion the build still succeeds:
  - Vite pulls `@abandonware/noble` into a 51 kB chunk and externalizes `util`/`events` (warnings only).
  - Loading `transport-ble-noble` then fails at runtime with `TypeError: r.inherits is not a function`.
  - `output-console` happens to load in the browser (it only uses rxjs), but has no purpose there.
- **The manifest stays authoritative:** discovery reads the manifest first and loads the entry it
  names. The `ui.client` field of Phase 3 can use the same mechanism.
- **Not covered:** duplicate-id handling and folder-without-manifest diagnostics. A glob over
  `*/manifest.json` cannot see folders without a manifest; this needs a second glob over `*/` or is
  accepted as a difference from filesystem discovery.

### Sketch: host adapter the core needs (not implemented)

```text
packages/core
  PluginHost({ discovery: DiscoveryPort, loader: ModuleLoaderPort, logger: LoggerPort, clock, ids: () => string })
  DiscoveryPort.discover(): Promise<{ manifestJson: string; location: string }[]>   // manifest stays authoritative
  ModuleLoaderPort.load(location): Promise<PluginDefinition>

apps/headless (Node)      → FsDiscovery (fs + tinyglobby), FileUrlLoader (pathToFileURL + import()), pino
apps/native   (WebView)   → BundledDiscovery (import.meta.glob('plugins/*/manifest.json', { query: '?raw' })),
                            StaticLoader (import.meta.glob('plugins/*/index.ts')), console/pino-browser logger
core/src/index.ts         → must not re-export FsDiscovery (keeps tinyglobby out of WebView bundles)
event ids                 → globalThis.crypto.randomUUID() (Node ≥ 19 and every target WebView have it)
```

## 6. Observations about the stack (not fixed here)

### 6.1 `blec` / `tauri-plugin-blec`

- **Scan filtering is client-side.** `discover` calls btleplug `start_scan(ScanFilter::default())`
  and filters each 200 ms poll of `adapter.peripherals()`. That is fine in the foreground. iOS
  background scanning requires an OS-level service filter, which is out of scope now but matters later.
- **`discover` panics when its receiver goes away** (`tx.send(..).await.expect("failed to send
  devices")`). The spike keeps draining its receiver until blec closes it.
- **Connecting to an unknown id runs an internal scan** (`resolve_peripheral` → `scan_for`, then
  `retrieve_peripherals`). So after an app restart, "reconnect by remembered id without a new scan"
  is really "without a scan the app starts". On CoreBluetooth `retrievePeripheralsWithIdentifiers`
  could avoid it entirely; blec only re-registers after the scan.
- When a peripheral has no local name, blec uses the peripheral id as the name.
- One scan at a time: a new `discover` aborts the running one.

### 6.2 iOS

- blec's README says to add `CoreBluetooth.framework` by hand in Xcode. Without it the link fails
  (`Undefined symbols: _CBAdvertisementDataLocalNameKey …`).
- Reproducible fix: `"bundle": { "iOS": { "frameworks": ["CoreBluetooth"] } }`. **Tauri only applies
  it when `gen/apple` is generated.** An existing project has to be regenerated (`rm -rf
  src-tauri/gen/apple && tauri ios init`).
- `src-tauri/Info.plist` is merged into the iOS app as well (verified in the IPA). No separate
  `Info.ios.plist` was needed.

### 6.3 Android

- blec's manifest declares `ACCESS_FINE_LOCATION` / `ACCESS_COARSE_LOCATION` and `BLUETOOTH_ADMIN`
  **without `maxSdkVersion="30"`**, so location is declared on Android 12+ even though
  `BLUETOOTH_SCAN` has `neverForLocation`.
- At runtime this did not matter on Android 17 (Pixel 8, emulator). Only the "Nearby devices"
  group was requested and granted; location stayed `granted=false` and the scan still found 50
  peripherals. The declaration still shows up in the Play Store listing and on older Android
  versions. An app can drop it with `tools:node="replace"` + `maxSdkVersion="30"` in `gen/android`
  (not done here).
- `minSdkVersion` 26 (set in `tauri.conf.json`); `targetSdkVersion` 37.
- `tauri android build` refuses `version: 0.0.0`.

### 6.4 WebView timing

- WKWebView (macOS and the iOS Simulator) coarsens `performance.now()` and `timeOrigin` to 1 ms, and
  its wall clock is offset by about 1 ms from Rust's `SystemTime`. Android System WebView gives
  sub-ms timers, with an offset of about 0.1 ms.
- Rust receive timestamps are therefore the only sub-millisecond-accurate times in the app. That
  matches the tech-stack rule: `receivedAt` comes from the injected clock, Rust times are diagnostics only.

### 6.5 Licenses of the Rust dependency tree

From `src-tauri/Cargo.lock`: 474 crates in total. The table covers the 320 crates resolved for the
macOS/iOS/Android builds and present in the local registry; Windows-only crates were not downloaded.

| License expression | Crates |
|---|---|
| MIT OR Apache-2.0 (incl. spelling variants) | 192 |
| MIT | 61 |
| Zlib OR Apache-2.0 OR MIT (`objc2-*`, `dispatch2`, `tinyvec`) | 18 |
| Unicode-3.0 (`icu_*`, `zerovec`, …) | 18 |
| Unlicense OR MIT | 7 |
| **MPL-2.0** (`cssparser`, `cssparser-macros`, `selectors`, `dtoa-short`, `option-ext`) | 5 |
| Apache-2.0, Apache-2.0 AND MIT, BSD-3-Clause, BSD/MIT/Apache combinations, Zlib, 0BSD/CC0 alternatives, `(MIT OR Apache-2.0) AND Unicode-3.0` | 19 |

- No GPL-2.0-only, proprietary or unlicensed crates.
- MPL-2.0 is file-level copyleft and explicitly compatible with (A)GPL-3.0 combination (MPL-2.0 §3.3).
  The crates arrive through Tauri itself (HTML/CSS handling in `tauri-utils`; `option-ext` via `dirs`).
- Needs the normal attribution in a shipped app's NOTICE; nothing for the spike.

## 7. Contract gaps (`@ridrs/contracts` `ble.ts`)

`TauriBleCentral` implements `BleCentral` / `BleConnection` **unchanged**. The spike needed these
additions as experiment-local extensions (`SpikeBleConnection`, `SpikeDiscoveredPeripheral`):

1. **`write(target, bytes, { withResponse })`** on `BleConnection`: needed for FTMS control (Phase 8)
   and Zwift Ride's RideOn handshake.
2. **RSSI** in `BleDiscoveredPeripheral`: useful for choosing between several trainers. The spike
   passes it as an extra property.
3. **Transport receive timestamp** (optional, diagnostics only): the spike exposes
   `subscribeTimed`. The contract should not carry it into measurement events.
4. **`onDisconnected` semantics are unspecified for user-initiated disconnects.** blec reports both
   kinds. The adapter suppresses the user-initiated ones and fires at most once per connection object
   ("once per loss"). The contract should say so.
5. **Scan termination:** `scan` is an `AsyncIterable` that only ends on abort or `break`. The
   contract should state whether a transport may end it on its own (blec's scan has a timeout; the
   spike hides it).
6. **Two subscriptions to the same characteristic:** blec replaces the callback. The contract
   should define it (reject, or fan out in TS).
7. **Permissions:** Android needs a runtime permission request before scanning. That is not a
   `ble.central` concern but needs a home (composition root or a small capability).
8. **Ids:** treated as opaque, stable per installation (CoreBluetooth UUID, Android MAC). Nothing in
   the contract needs to change. `name` may be the id when the device has no local name.
9. **`PluginLogger` = pino `Logger`** (see 5): couples every host to pino's shape.
10. **No "Bluetooth unavailable" signal.** In the iOS Simulator (adapter state `Unknown`) a scan
    starts, yields nothing and never fails. A device plugin cannot tell "no trainer nearby" from
    "Bluetooth off / unsupported / not permitted". The contract needs an adapter state (or a scan
    that rejects), so the UI can say why nothing is found. The spike reads it through
    `ble_adapter_state` (blec: `On` / `Off` / `Unknown`).

## 8. What could not be verified

- **Anything with an FTMS trainer or Zwift Ride**, on all platforms: checks 5, 6, 8, 11, 12, and
  3/4/9 for a trainer specifically. On Android, 3, 4, 7 and 9 were shown with an HR device instead.
- **macOS BLE connections:** macOS only scanned; nothing was connected there.
- **Windows** entirely (no Windows machine; cross-compiling with `cargo-xwin` was not attempted).
  The noble comparison in rule 7 is moot without a Windows result.
- **iOS on a device:** the device IPA builds, but the iPhone was not connected. The simulator has no
  Bluetooth, so **every iOS BLE check is still open**. iOS is now the biggest unknown.
- **Android release build on device:** only the debug APK was installed. Latency and cold start were
  measured on debug.
- iOS **release** IPA size (needs a distribution profile; out of scope per the non-goals).
- Permission prompts on macOS and iOS; the **denied / granted-later** flows on every platform.
- 30-minute stability, background/screen-lock behavior, 4 simultaneous connections.
- Stage 3 was run in Chromium (browser pane), not inside a WebView. Stages 1 and 2 ran in WKWebView
  (macOS, iOS Simulator) and Android System WebView.

## 9. Recommendation (brief section 7)

**No decision yet.** The trainer must-pass checks (5, 6, 8, 11) could not be run on any platform,
iOS BLE is untested on a device, and Windows is untested. Section 7 forbids filling cells by
assumption. What this session does establish:

- One Tauri 2 project builds macOS, iOS and Android artifacts with the same TypeScript and the same
  Rust BLE layer. The app installs and starts on the iOS Simulator, an Android emulator and a real
  Pixel 8. Windows is untested.
- **Android mobile BLE works through Tauri on real hardware.** That was the risk the tech-stack
  document named first ("Tauri's mobile support is younger"). On the Pixel 8:
  - no system picker, and only the "Nearby devices" permission (no location);
  - service-filtered scan;
  - connect, and live notifications through the binary channel;
  - reconnect by remembered id after an app restart.
- The contract seam holds. `TauriBleCentral` implements the **unchanged** `BleCentral`, and the
  **unchanged** `device-ftms-trainer` plugin runs on it in WKWebView and Android System WebView.
- The native side can stay "dumb". `ble.rs` contains no protocol logic. Reconnect policy stays in
  TS with `p-retry`, as in Phase 2.
- IPC is not a bottleneck:
  - binary frames, no loss at 200 Hz on every target;
  - median latency 0.5–0.9 ms on macOS and the simulators;
  - 2–6 ms on the Pixel 8 debug build, with a p95 up to 23 ms at low rates (re-measure on release).
- The core is **not** WebView-ready (stage 3 ❌). Per section 7 this is not a blocker for the shell
  decision, but it is the **first piece of work before Phase 3**. Ports for discovery, module loading
  and logging, and no `tinyglobby` in the core barrel.

**To close the spike** (estimated 1–2 days with the hardware in one place):

1. Connect the iPhone (USB or Wi-Fi, unlocked) and run `npx tauri ios dev`. Repeat what the Pixel 8
   showed (permission prompt, HR scan/connect/notify, reconnect by id). This is the most important
   open item.
2. Run checks 2–13 with a KICKR CORE (or another FTMS trainer) and an HR strap on macOS, iOS and
   Android, using an Android **release** build.
3. Build and run on a real Windows 10/11 PC and repeat checks 1–13 there.
4. Fill the NV cells. Then apply section 7: all must-pass ✅/⚠️ → **Go: Tauri 2**. Mobile BLE
   failing → **Split** with `@capacitor-community/bluetooth-le` (½ day comparison). Windows BLE
   failing → noble comparison.

## 10. Draft ADR

> Move to `docs/decisions/` only after the hardware checks above are filled and accepted.

```markdown
<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 00NN: GUI shell and native BLE for ridrs apps

## Status

Proposed. Pending the hardware checks of `experiments/tauri-ble-spike/FINDINGS.md`.

## Context

ridrs must ship installable apps for Windows, macOS, iOS and Android from one TypeScript code base,
with native Bluetooth LE, while the headless Node app stays the reference runtime for tests. Phase 3
builds the first real application on the final UI and plugin system, so the shell must be chosen
first. Web Bluetooth is excluded (picker, user gesture, unstable per-origin ids, no WKWebView support).

## Decision

1. Use **Tauri 2** as the single app shell for all four targets (`apps/native`).
2. Bluetooth LE in the apps goes through a thin Rust layer on top of `tauri-plugin-blec`
   (btleplug on Windows/macOS/iOS, blec's Kotlin backend on Android). The layer only moves bytes:
   scan with service filter, connect, connection-lost, subscribe with a Rust receive timestamp,
   write, disconnect. Notifications cross IPC as binary frames.
3. TypeScript exposes it as the existing `ble.central` capability (`transport-ble-tauri`). Device
   plugins stay platform-free. Reconnect policy stays in TypeScript.
4. Before Phase 3 UI work, the core becomes runtime-neutral: discovery, module loading and logging
   behind ports; `globalThis.crypto.randomUUID`; no Node-only modules reachable from the core barrel.
5. `write` is added to `BleConnection` in the phase that first needs it, with its own scenarios.

## Alternatives considered

- **Capacitor (mobile) + Tauri (desktop):** proven mobile BLE, but two shells and two BLE transports.
  Kept as the fallback if mobile checks fail.
- **Own Tauri plugin directly on btleplug:** smallest dependency surface, but re-implements Android BLE
  (btleplug's Android path needs manual JNI wiring). Possible later if blec stalls.
- **tauri-plugin-blec's own JS commands:** no service filter, no timestamps, JSON byte arrays, panicking
  `expect`s in the notification path.
- **Electron, React Native, NativeScript, Flutter/.NET MAUI/KMP:** see `prompts/tech-stack-ui-and-bluetooth.md` §3.2.

## Consequences

- One Rust component (≈280 lines) to maintain, plus a dependency on blec's release cadence.
- iOS needs `bundle.iOS.frameworks: ["CoreBluetooth"]`, applied when `gen/apple` is generated.
- Android manifest permissions from blec need an override so location is not declared on Android 12+.
- WebView timers are coarse (1 ms in WKWebView): Rust timestamps are the only precise receive times
  (diagnostics only; measurement time stays the injected clock).
- `PluginHost` needs a bundled discovery (`import.meta.glob`) and static module loader for apps; the
  headless filesystem discovery stays unchanged and keeps the manifest authoritative.
```
