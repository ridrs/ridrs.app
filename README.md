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
- `packages/spatial/`: Pure, deterministic sampling of the spatial data layer: windows of samples by distance, linear and stepwise interpolation, values ahead of the rider (`@ridrs/spatial`, `ctx.spatial`).
- `packages/metric-source/` and `packages/ble-peripheral/`: Shared logic of the metric plugins and of the BLE device plugins (`@ridrs/metric-source`, `@ridrs/ble-peripheral`).
- `packages/ui-sdk/`: Client contract for UI plugins (`@ridrs/ui-sdk`, `Apache-2.0`); `packages/ui-shell/`: the shell that composes screens and slots; `packages/ui-bridge/`: in-process bridge between shell and host; `packages/presentation/`: interpolated physics states and the frame clock for frame-driven UI plugins (`@ridrs/presentation`).
- `plugins/`: Production plugins (BLE transports for Node and Tauri, FTMS trainer, heart-rate sensor, power/cadence/heart-rate metrics, power-to-heart-rate ratio, console output, activity session, physics engine and models, recording session, FIT export, app file storage for Node and Tauri, UI screens, HUD and widgets).
- `packages/recording/`, `packages/fit/`, `packages/replay/`: The ridrs recording format (writer, reader, recovery), the own FIT encoder, and the headless deterministic replay (`@ridrs/recording`, `@ridrs/fit`, `@ridrs/replay`).
- `packages/ble-bridge/`: The companion bridge protocol: pairing, GATT forwarding, heartbeat; companion and ridrs side (`@ridrs/ble-bridge`). `packages/ble-tauri/`: `BleCentral` on the native BLE commands (`@ridrs/ble-tauri`). `packages/ble-simulator/`: in-process BLE simulator and dummy devices (`@ridrs/ble-simulator`).
- `crates/`: Rust crates hosted by both Tauri apps: `ridrs-ble` (native BLE commands) and `ridrs-bridge` (mDNS and WebSocket of the companion bridge).
- `packages/testing/`: Test harness: simulated Tauri bridge, simulated companion network (`@ridrs/testing`).
- `tests/`: Executable Gherkin specifications (`tests/features/`), step definitions, test harness, and fixture plugins.
- `docs/`: Architecture documentation (`docs/architecture/`), file formats (`docs/formats/`) and Architecture Decision Records (`docs/decisions/`).
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

Since Phase 6 the virtual rider rides a built-in demo course: 2 km flat, 1 km at 5 %, 500 m flat, 1 km at −5 %, then flat. Since Phase 10 the landscape lives in the UI: `ui-landscape-demo` draws it and reports the terrain 20 m ahead of what it shows, sampled every metre; a driver (`world-driver-ui`) validates it and the spatial data layer (`@ridrs/spatial`) holds it for the physics, which keeps the distance itself (ADR 0044). The surface alternates every 500 m between asphalt and gravel, drawn in different colours. Gravel doubles the rolling resistance, so 200 W settle near 32.2 km/h there instead of 34.2 km/h. **Headless rides are always flat on asphalt:** without a UI no terrain arrives. Gravity opposes the rider uphill and pushes them downhill; air density comes from `physics-environment`. The HUD shows the current gradient after speed and distance. At a steady 200 W the speed settles near 34.2 km/h on the flat, about 14.9 km/h on the climb and about 57.9 km/h on the descent. Without pedalling the rider keeps rolling downhill but comes to rest on a climb and stays there (no rolling back). See `docs/architecture/physics.md` and ADR 0027.

Manual check (`tauri dev` / `tauri android dev` as above) with a real smart trainer, or with the developer companion's simulated trainer, on the demo course:

- At about 200 W the gradient shows 0.0 % for about 3.7 minutes, then **5.0 %**. Within a few seconds the speed drops from about 34 to about 15 km/h.
- After the climb and 500 m of flat, the gradient shows **-5.0 %** and the speed rises towards about 58 km/h.
- Stop pedalling on the descent: the rider keeps rolling. Stop on the climb: the rider comes to rest and stays there.
- From 500 m the road turns to gravel (a lighter brown) and the speed on the flat drops by about 2 km/h; from 1 km it is asphalt again, and so on every 500 m. The climb and the descent cross gravel too.

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

## Recording, replay and FIT export

Every ride is recorded from "Start ride" to "Finish ride": every event, every diagnostic and the raw device bytes, with a minute of pre-roll and a configuration snapshot. After "Finish ride" the main screen shows **Ride saved** with the distance, the duration and the file names. Each ride is also exported as a FIT activity file. Recording is always on.

**Where the files are:** `recordings/` in the app data directory. `ride-<UTC start>-<session>.ridrs` is the recording (gzip JSON Lines, [format](docs/formats/ridrs-recording-v1.md)), `….fit` the FIT export, and `….ridrs.jsonl` a recording while it is open (recovered at the next start after a crash).

| Host | Data directory |
|---|---|
| headless (macOS) | `~/Library/Application Support/ridrs` |
| headless (Linux) | `~/.local/share/ridrs` |
| headless, any OS | `$RIDRS_DATA_DIR` if set |
| native app | the app container's app data directory (`$APPDATA/recordings`, Tauri) |

Inspect, replay and export a recording headless:

```bash
pnpm --filter @ridrs/headless start recording inspect ~/Library/Application\ Support/ridrs/recordings/ride-20261101T100000Z-3f2a9c1d.ridrs
```

```bash
pnpm --filter @ridrs/headless start recording replay <file.ridrs> --json
```

```bash
pnpm --filter @ridrs/headless start recording export-fit <file.ridrs> -o ride.fit
```

`replay` runs the recorded bytes and rider input through the **current** plugins on a virtual clock and reports configuration and version differences, the compared streams and "identical" or the first difference (exit 0 identical, 1 different, 2 error). `-p <dir>` chooses the plugin directories (default `plugins`). See [recording-and-replay.md](docs/architecture/recording-and-replay.md) and [fit-export.md](docs/architecture/fit-export.md).

**Deterministic:** the host runs on logical time with one queue for external inputs, so a recording made on real timers (a real ride) replays identically ([time and scheduling](docs/architecture/time-and-scheduling.md)).

**Manual check (with hardware).** On the Mac (and Android, pulling the files with `adb`):

1. Ride about 10 minutes with a trainer (or the Phase 3b developer companion's simulated trainer) and a heart-rate sensor.
2. Finish; note the "Ride saved" panel.
3. Run `recording inspect` and `recording replay` on the file. Record whether the replay is identical (see the known limit above) and how long it took.
4. Upload the FIT file to at least one platform (Garmin Connect, Strava or intervals.icu) and compare power, heart rate, distance and duration with ridrs.

Record the file sizes (`.ridrs`, `.fit`) per 10 minutes, the replay duration, the platform that accepted the FIT file and any warnings.

The FIT files are written by ridrs' own encoder. The official Garmin FIT SDK (`@garmin/fitsdk`) is a test-only devDependency that validates every exported file; it is never bundled or distributed ([ADR 0034](docs/decisions/0034-fit-own-encoder-sdk-validation-only.md)). `pnpm check:native-bundle` builds the native app and checks that its bundle contains neither the SDK nor the Node storage provider.

## Trainer control: gradient, virtual gears and ERG

With an FTMS trainer that offers a control point (a KICKR CORE, say), ridrs takes control on connecting and drives its resistance ([trainer-control.md](docs/architecture/trainer-control.md)):

- **Free ride:** the trainer gets harder uphill and easier downhill, following the landscape, and gravel feels heavier (FTMS simulation parameters, at most once a second when they change).
- **Virtual shifting:** the Zwift Ride's shift buttons change one of 24 virtual gears (from 34 × 34 to 53 × 11 on a real 34 × 14; every ride starts in gear 12). The HUD shows the gear. A harder gear makes the same cadence harder; the virtual speed still comes from the power you measure.
- **ERG:** move the focus to **Target power** in the HUD with the arrow keys and press Enter: ERG holds 150 W. ↑ and ↓ change the target by 5 W, Back leaves ERG. The Zwift Ride's right power-up button starts ERG or adds 5 W, the left one takes 5 W off. Finishing the ride leaves ERG and gives the trainer a flat road.
- The trainer's details in the device setup show "Control: simulation", "ERG 150 W", "not supported", "refused" or "lost". A trainer without a control point stays a power and cadence sensor.
- Through the companion, trainer control needs a companion app of bridge protocol 1.3 or later. On Android, ridrs uses a patched copy of `tauri-plugin-blec` that enables indications ([ADR 0052](docs/decisions/0052-ble-write-with-response-read-and-indications.md)).

**Manual check (with hardware, D7).** A KICKR CORE with the Zwift Ride, on the Mac and on Android (directly and through the companion). Set the trainer's rider weight in the Wahoo app to about 75 kg (ridrs simulates 85 kg with the bike).

1. Ride the demo landscape in free ride. Check that the resistance follows the gradient and that gravel feels heavier.
2. Shift through all 24 gears at 90 rpm on the flat and note the power per gear (predicted: 81 W in gear 12, 163 W in gear 16, 342 W in gear 20; [ADR 0054](docs/decisions/0054-trainer-load-and-virtual-gear-formula.md)).
3. ERG 150 → 250 W: the power settles within a few seconds at any cadence between 70 and 100 rpm.
4. Switch the trainer off and on again: control comes back without a restart.
5. Finish the ride and replay the recording: "identical".

Record the power per gear, the ERG settle times and anything the KICKR CORE refused (the device details and the `trainer-command-failed` diagnostics).

## Tests

- `pnpm test` runs Vitest and Cucumber. Cucumber runs twice: Node-only scenarios, then the `@ui` scenarios (profile `ui`), which render the real shell and UI plugins into a headless DOM (happy-dom). No browser and no Rust toolchain are needed.
- `cargo test` in `crates/ridrs-ble` and `crates/ridrs-bridge` runs the Rust unit tests of the native BLE layer and the bridge network.

## Web Application

For instructions on local development and deployment of the web application, see the [web README](web/README.md).
