<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ridrs

Open-source, modular, headless-first indoor cycling platform.

## Repository Structure

- `apps/native/`: Native app (Tauri 2) for macOS, Android, iOS and Windows: core, plugins and GUI in one WebView process (`@ridrs/native`).
- `apps/companion/`: Companion app (Tauri 2, Android/iOS) that forwards a phone's Bluetooth to ridrs over the local network (`@ridrs/companion`).
- `apps/headless/`: Headless CLI composition root (`@ridrs/headless`).
- `packages/contracts/`: Public plugin, manifest, event, and capability contracts (`@ridrs/contracts`, `Apache-2.0`).
- `packages/core/`: Runtime-neutral application core: discovery ports, capability resolution, lifecycle, diagnostics, UI registry, typed event bus and the temporal data layer service `ctx.temporal` (`@ridrs/core`, `AGPL-3.0-or-later`; Node-only adapters in `@ridrs/core/node`).
- `packages/temporal/`: Pure, deterministic math of the temporal data layer: sampling intervals, freshness, values at a time, damped trend, time-weighted averages, snapshots (`@ridrs/temporal`).
- `packages/metric-source/` and `packages/ble-peripheral/`: Shared logic of the metric plugins and of the BLE device plugins (`@ridrs/metric-source`, `@ridrs/ble-peripheral`).
- `packages/ui-sdk/`: Client contract for UI plugins (`@ridrs/ui-sdk`, `Apache-2.0`); `packages/ui-shell/`: the shell that composes screens and slots; `packages/ui-bridge/`: in-process bridge between shell and host; `packages/presentation/`: interpolated physics states and the frame clock for frame-driven UI plugins (`@ridrs/presentation`).
- `plugins/`: Production plugins (BLE transports for Node and Tauri, FTMS trainer, heart-rate sensor, power/cadence/heart-rate metrics, power-to-heart-rate ratio, console output, activity session, physics engine and models, UI screens, HUD and widgets).
- `packages/ble-bridge/`: The companion bridge protocol: pairing, GATT forwarding, heartbeat; companion and ridrs side (`@ridrs/ble-bridge`). `packages/ble-tauri/`: `BleCentral` on the native BLE commands (`@ridrs/ble-tauri`). `packages/ble-simulator/`: in-process BLE simulator and dummy devices (`@ridrs/ble-simulator`).
- `crates/`: Rust crates hosted by both Tauri apps: `ridrs-ble` (native BLE commands) and `ridrs-bridge` (mDNS and WebSocket of the companion bridge).
- `packages/testing/`: Test harness: simulated Tauri bridge, simulated companion network (`@ridrs/testing`).
- `tests/`: Executable Gherkin specifications (`tests/features/`), step definitions, test harness, and fixture plugins.
- `docs/`: Architecture documentation (`docs/architecture/`) and Architecture Decision Records (`docs/decisions/`).
- `web/`: Cloudflare Worker application serving the project web page ([ridrs.app](https://ridrs.app)).

## Running ridrs headless

Install dependencies and verify the workspace:

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
```

Start the headless composition root against the example ping-pong plugins:

```bash
pnpm --filter @ridrs/headless start -- --plugins tests/fixtures/plugins/ping-pong
```

Press `Ctrl+C` (`SIGINT`) to gracefully stop and dispose all plugins.

### Live power and cadence

With hardware (a powered-on FTMS trainer nearby; on macOS the terminal app needs Bluetooth permission):

```bash
pnpm --filter @ridrs/headless start -- --plugins plugins
```

The console shows `searching`, `connecting`, `connected`, then live power and cadence. Switching the trainer off shows `reconnecting` and unavailable values; `Ctrl+C` disconnects and exits with code 0.

Without hardware (simulated trainer `SIM KICKR`):

```bash
pnpm --filter @ridrs/headless start -- --plugins plugins --plugins tests/fixtures/plugins/simulated-trainer --disable transport-ble-noble
```

## The native app: start a ride and see power and cadence

`apps/native` composes all plugins (bundled at build time), the in-process UI bridge and the shell in the Tauri WebView. Prerequisites: Rust (`rustup`), and for Android the Android SDK + NDK (`ANDROID_HOME`, `NDK_HOME`, `JAVA_HOME`) and the Rust target `aarch64-linux-android`; for iOS Xcode, `xcodegen` and CocoaPods. The pipeline below (`pnpm test` etc.) needs none of them.

```bash
pnpm --filter @ridrs/native tauri dev
```

```bash
pnpm --filter @ridrs/native tauri android dev
```

Manual check with a real FTMS trainer: press **Start ride**, pedal: power and cadence appear in the lower corners over the landscape. Switch the trainer off: both show `–` with "disconnected"; switch it on: values return. Press **Finish ride**: back to the main screen. The screen stays on while a ride runs. On Android the app asks for "Nearby devices" first. On macOS the app needs Bluetooth permission on first use.

Without hardware the same composition runs in the tests with the simulated trainer (`tests/features/apps/ride-in-native-app.feature`). The frontend alone also runs in a browser (`pnpm --filter @ridrs/native build`, then `pnpm --filter @ridrs/native exec vite preview`): without Tauri there is no BLE, so the widgets show dashes.

## Heart rate and values at different rates

Since Phase 4 the app also connects to a Bluetooth heart-rate sensor (strap or band, Heart Rate Service `0x180D`) and shows four HUD widgets: power, cadence, heart rate and the power-to-heart-rate ratio (10 s averages, W/bpm). Each source is flagged "no signal" after a silence that fits its own rate: about 2 s for a 4 Hz trainer, 8–10 s for a heart-rate sensor. See `docs/architecture/temporal-data-layer.md`.

Manual check with a real heart-rate sensor, on a phone or the Mac (`tauri dev` / `tauri android dev` as above), with or without a trainer:

- Without a trainer: heart rate appears; power shows `–`, the ratio `–` with "no source".
- With a trainer: all four widgets show values. The ratio shows "warming up" for about 8 s, then a value.
- Take the sensor off (or move out of range): the heart-rate widget shows "no signal" or "disconnected" while power stays live, and the ratio follows.

Record the sensor model, its notification interval (count the updates over 30 s) and the time from taking it off until "no signal". Without hardware the same composition runs in `tests/features/apps/ride-with-heart-rate.feature` with the `simulated-ride` fixture (`SIM KICKR` and `SIM HRM`).

## Virtual speed: the physics engine

Since Phase 5 measured power moves a virtual rider (75 kg, bicycle 10 kg, flat road, still air). The HUD shows its speed (km/h) and distance (km) after the metric widgets. At a steady 200 W the speed reaches about 22 km/h after 10 s and settles near 34.2 km/h after about a minute. The physics runs at a fixed 100 Hz from the power the temporal data layer reports for each step time; it never invents power. See `docs/architecture/physics.md`.

Manual check (`tauri dev` / `tauri android dev` as above) with a real smart trainer, or with the developer companion's simulated trainer (profile `steady`, 220 W) if none is at hand:

- Ride at a steady 200 W: the speed rises and settles near 34 km/h within about a minute.
- Stop pedalling: about 2 s later the speed starts to decay (stale power) and slowly reaches 0.0 km/h. The distance stops growing.
- Without a trainer: 0.0 km/h and 0.00 km, power shows `–` with "no source".
- Finish and start a new ride: speed and distance start again at zero.

Record the platform, the power source, the time to reach 30 km/h at 200 W, and whether the speed display looks smooth enough at 4 updates per second (Phase 7 makes it fluid). Without hardware the same composition runs in `tests/features/apps/ride-with-virtual-speed.feature` with the `simulated-trainer` fixture.

## Climbs and descents: extended physics

Since Phase 6 the virtual rider rides a built-in demo course: 2 km flat, 1 km at 5 %, 500 m flat, 1 km at −5 %, then flat. Gravity opposes the rider uphill and pushes them downhill; air density comes from `physics-environment`. The HUD shows the current gradient after speed and distance. At a steady 200 W the speed settles near 34.2 km/h on the flat, about 14.9 km/h on the climb and about 57.9 km/h on the descent. Without pedalling the rider keeps rolling downhill but comes to rest on a climb and stays there (no rolling back). See `docs/architecture/physics.md` and ADR 0027.

Manual check (`tauri dev` / `tauri android dev` as above) with a real smart trainer, or with the developer companion's simulated trainer, on the demo course:

- At about 200 W the gradient shows 0.0 % for about 3.7 minutes, then **5.0 %**. Within a few seconds the speed drops from about 34 to about 15 km/h.
- After the climb and 500 m of flat, the gradient shows **-5.0 %** and the speed rises towards about 58 km/h.
- Stop pedalling on the descent: the rider keeps rolling. Stop on the climb: the rider comes to rest and stays there.

Record the platform and the power source, the speed on each segment, and whether the jump at the segment boundaries feels acceptable. Without hardware a short climb runs in `tests/features/apps/ride-a-climb.feature` with the `simulated-trainer` and `short-climb` fixtures.

## Smooth rendering: simulation and rendering decoupled

Since Phase 7 the GUI renders on its own clock at the display's refresh rate while the physics keeps its fixed 100 Hz. The engine streams every step in batches of five (50 ms); the landscape shows the physics 60 ms in the past, interpolated between the two neighbouring steps, so the road markings move smoothly. Rendering never drives or changes the simulation: speed, distance and gradient are exactly those of Phase 6, and the HUD numbers still update at 4 Hz. See `docs/architecture/presentation.md` and ADR 0028.

Manual check (`tauri dev` / `tauri android dev` as above) on the Mac and on an Android phone (e.g. a Pixel 8), with a real smart trainer or the developer companion's simulated trainer:

- The road markings move smoothly from the first seconds of the ride. Riding faster makes them move faster; on the demo course's climb they slow down.
- Hide the app and show it again: the markings continue at the right place, and speed and distance were not affected.
- At ride finish the landscape logs `Landscape presentation at ride finish: {frames, exact, interpolated, held, none}` (WebView developer tools console).

Record the platform and its display refresh rate, the share of `held` frames at ride finish, visible stutter (yes/no), and frame drops from the WebView's developer tools, if available. This is the evidence for or against moving the physics to a Web Worker later. Without hardware the same composition runs in `tests/features/apps/ride-with-moving-road.feature` with the `simulated-trainer` fixture and a 60 FPS frame source.

## The companion bridge: a phone holds the Bluetooth link

When the device running ridrs cannot reach the trainer (a Mac or TV far from the bike, flaky Bluetooth), a phone next to the bike runs the **ridrs companion** (`apps/companion`). It connects to the trainer and forwards raw Bluetooth traffic to ridrs over the local network. Device plugins in ridrs decode the bytes as usual. See `docs/architecture/ble-bridge.md`.

```bash
pnpm --filter @ridrs/companion tauri android dev          # companion on a phone or emulator
pnpm --filter @ridrs/companion tauri android build --apk --debug --target aarch64
```

In ridrs, press **Use a companion phone** on the main screen; the app restarts with the bridge transport and shows a QR code. On the phone, press **Scan ridrs QR code** in the companion and point it at that code: ridrs finds the phone in the same Wi-Fi and pairs by itself. Alternatively, enter the 6-digit code shown on the phone next to the companion that ridrs lists, and press **Pair**. The pairing is kept; later starts connect without either. **Use this device's Bluetooth** switches back.

On Android the companion keeps the screen on and must stay open: with the screen off, Android cuts the app off the network. It asks for "Nearby devices" (Bluetooth) and for local network access.

**Developer companion with dummy devices**: the developer build adds simulated FTMS trainers next to real Bluetooth, for manual tests of ridrs without hardware. Profiles: `steady` (220 W, 92 rpm), `ramp` (100 W, +10 W every 3 s), `dropout` (link lost after 20 s for 5 s), `malformed` (every 10th packet truncated). Release builds contain none of this code.

```bash
pnpm --filter @ridrs/companion tauri android build --apk --debug --target aarch64 \
  --config '{"build":{"beforeBuildCommand":"pnpm build:dummy"}}'
```

On the Android emulator, mDNS does not cross the emulator's NAT to a ridrs on the host. Run ridrs in the same emulator instead, or check a companion from the host with the probe through a forwarded port (`adb forward tcp:47000 tcp:42229`): `pnpm --filter @ridrs/companion probe <host:port> <code>` pairs like ridrs does and prints the trainer's notifications.

## Tests

- `pnpm test` runs Vitest and Cucumber. Cucumber runs twice: Node-only scenarios, then the `@ui` scenarios (profile `ui`), which render the real shell and UI plugins into a headless DOM (happy-dom). No browser and no Rust toolchain are needed.
- `cargo test` in `crates/ridrs-ble` and `crates/ridrs-bridge` runs the Rust unit tests of the native BLE layer and the bridge network.

## Web Application

For instructions on local development and deployment of the web application, see the [web README](web/README.md).
