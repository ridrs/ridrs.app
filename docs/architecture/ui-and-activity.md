<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# Activity and UI as Plugins

Phase 3 use case: **I start a ride and see my power and cadence.** The GUI is not an application, it is a set of plugins: a *screen* declares *extension points*, independent plugins *contribute* to them, and the screen never knows its contributors. The HUD is painted **over** the landscape (layers), never beside it.

```text
Smart trainer ──► transport-ble-tauri ──► device-ftms-trainer ──► metric-power / metric-cadence
   (Rust ble.rs via tauri-plugin-blec)        (Phase 2, unchanged)      │ metric.power, metric.cadence
                                                                         ▼
apps/native  (one process: the Tauri WebView)
  PluginHost (bundled plugins) ──► UI registry ──► in-process UiBridge ──► shell
                                                    allow-list,             one screen at a time,
                                                    last-value replay       synced slots
   ├─ screen "main"      ui-main-screen          [Start ride]
   └─ screen "activity"  ui-activity-screen      declares: activity/landscape, activity/hud   [Finish ride]
         ├─ activity/landscape  ◄─ ui-landscape-demo     (Phase 10: the world's sensor, publishes ui.terrain-observed)
         └─ activity/hud        ◄─ ui-hud                declares: hud/widget
               └─ hud/widget    ◄─ ui-widget-power, ui-widget-cadence,
                                   ui-widget-heart-rate, ui-widget-power-heart-rate-ratio (Phase 4)

activity-session  (headless)   activity.start-requested / finish-requested → activity.state-changed
```

## Runtime-neutral core

`@ridrs/core` and `@ridrs/contracts` import no `node:*` module and no Node-only library (enforced by `dependency-cruiser`), so the same core runs in Node (`apps/headless`) and in a WebView (`apps/native`). The Node-specific parts sit behind ports:

| Port | Node adapter (`@ridrs/core/node`) | App adapter (`@ridrs/core`) |
|---|---|---|
| `PluginSource` (discovery + module loading) | `createFileSystemPluginSource(dir)` | `createBundledPluginSource({ manifests, modules })` fed by `import.meta.glob` |
| `PluginLogger` (structural, in contracts) | pino | `createConsoleLogger()` |
| ids | `ctx.ids` from the host's `runId` ([time-and-scheduling.md](time-and-scheduling.md)) | same |

Each host leaves out plugins its runtime cannot run: the app bundle excludes `transport-ble-noble` at build time, the headless app disables `transport-ble-tauri` at runtime.

## Manifest `ui` section and UI registry

A plugin declares its UI in the manifest (validated by `uiManifestSectionSchema`, strict):

- `client`: browser module relative to the plugin folder (required with screens or contributions; may not leave the folder).
- `screens[]`: `{ id, export, extensionPoints? }`. The `id` is the navigation path.
- `contributions[]`: `{ id, extensionPoint, export, order?, extensionPoints? }`. Contributions may offer extension points of their own (nesting).
- `events.subscribe` / `events.publish`: the event ids the client code may use. Their union over all started UI plugins is the bridge allow-list.

The core indexes the UI sections of the **started** plugins into a `UiRegistry` (`computeUiRegistry`, pure and deterministic), exposes it as `ctx.ui.registry()` and `host.getUiRegistry()`, and publishes `core.ui-registry.changed` (`{ revision }`) when it changes. It is recomputed once after `host.start()` and after every `stopPlugin` / `startPlugin`, so transient start order never shows up. Contributions are ordered by `order`, then plugin id, then contribution id. Rule violations are diagnostics; the affected entry is left out, the plugin keeps running:

| Code | Situation |
|---|---|
| `unknown-extension-point` | A contribution targets a point no started screen or contribution offers. |
| `duplicate-screen` / `duplicate-extension-point` | Declared twice; the smaller plugin id wins. |
| `client-entry-missing` | The plugin source cannot deliver `ui.client` (no file on disk, or not in the bundle). |
| `client-load-failure` | A client module failed to load or a component threw on mount (reported by the shell). |

The core never knows what a screen or extension point means and never names one.

## Client contract, shell and bridge

- **`@ridrs/ui-sdk`** (Apache-2.0, imports contracts only): `UiComponent = (container, ctx) => cleanup | void`, the `UiContext` (`events.subscribe/publish` limited to the plugin's own declared events, `slot(point, container)`, `navigate(path)`, `frames.onFrame(handler)` since Phase 7, `onBack(handler)`), the `UiBridge` port (with `now()`, the host clock, since Phase 7), and the shared metric display rules (`describeMetricReading`: values rounded half up to their unit's precision - `W`, `rpm`, `bpm` whole numbers, `W/bpm` two decimals; reasons `no source`, `disconnected`, `no signal`, `warming up`).
- **`@ridrs/ui-shell`**: plain DOM, no framework. Renders exactly one screen (`main` first, else the alphabetically first), mounts each contribution in a wrapper `data-contribution="<pluginId>/<contributionId>"`, keeps slots in sync with the registry without remounting unchanged contributions, and releases everything a component obtained through its context when it unmounts. A component that fails to load or throws is isolated: its wrapper stays empty and the shell reports `client-load-failure`. Navigation is deferred by a microtask, so components may navigate from their own handlers. Since Phase 7 the shell owns the app's one frame clock (`requestAnimationFrame`, or `ShellOptions.frameSource`), see [presentation.md](presentation.md).
- **`@ridrs/ui-bridge`**: `createInProcessUiBridge(host, events)`. Enforces the allow-list (`event-not-allowed`), publishes on behalf of client code with the source `ui-bridge` (payloads validated by the bus: `invalid-event-payload`), and replays the **latest envelope per event** to every new subscriber, so a reloaded or second UI knows the current ride state and metric values. It is created before `host.start()`.

A remote bridge (the deferred `ui-gateway-web`, WebSocket) would implement the same `UiBridge` port; neither the shell nor any UI plugin would change.

## Keyboard, remote and Back

Every UI is usable with the arrow keys, Enter and Back alone (AGENTS.md rule 12): a rider on the bike reaches for a keyboard, a remote or a controller, not the mouse. The shell does it for every screen with `keyboardNavigation(root, { back })` ([ADR 0045](../decisions/0045-keyboard-navigation-tabbable.md)): the arrow keys move the focus through the screen's focusable elements in reading order (Down and Right forward, Up and Left back) and stop at the ends; without focus, the first arrow focuses the first element. Enter keeps the browser's default, which activates buttons and links and submits forms. Text fields keep Left, Right and Backspace for the caret, selects and text areas all arrows. Escape, Backspace, and the back keys of remotes (`BrowserBack`, `GoBack`) are **Back**, and so is Android's back button (`ShellOptions.backButton`; `apps/native` passes Tauri's `onBackButtonPress`, which also keeps Back from closing the app). Keys with Alt, Ctrl or ⌘ and keys a component already handled (`preventDefault`) are left alone.

Back goes to the component that registered `ctx.onBack(handler)` last and is still mounted; without one, Back does nothing (the main screen). `setup` closes the details and puts the focus back on their row, or leaves for `main`; `activity` never ends a ride on Back but moves the focus to Finish ride, which Enter then confirms. Controls show their focus only when they have it (`:focus-visible`), never as a resting look. The companion app has one screen and uses the arrow keys only. `keyboard-navigation.feature` covers it; Android's back button is covered with a fake in `ride-in-native-app.feature`.

## Layering

`ui-activity-screen` stacks its two slot containers absolutely in one stacking context: `activity/landscape` (z 0), `activity/hud` (z 1, `pointer-events: none`), and its own **Finish ride** button (z 2). `ui-hud` lays out `hud/widget` in the lower corners and lets pointer events through except on widgets. Screens navigate on `activity.state-changed`, not on clicks: `running` leads to `activity` (including the replayed state after a reload), anything else back to `main`.

## Activity session

`activity-session` publishes `{ state: 'idle' }` on start, moves to `running` (new `sessionId` from `ctx.ids.next()`, `startedAt` from the injected clock) on `activity.start-requested` and to `finished` on `activity.finish-requested`. Any other transition is an `invalid-transition` diagnostic with no event. A ride never needs a trainer.

## Tests

- Registry, activity and bundled discovery: Cucumber through the real host with probe plugins.
- `transport-ble-tauri`: Cucumber against a simulated Tauri bridge (`@tauri-apps/api/mocks` + `BleSimulator`), plus Vitest unit tests.
- Composition and the vertical use case: Cucumber `@ui` scenarios run the real host, bridge, shell and UI plugins in happy-dom (profile `ui`); `ride-in-native-app.feature` uses the native app's own composition root `startRidrsApp` with the simulated trainer.

## Phase 4 widgets

`ui-widget-heart-rate` (`widget-heart-rate`, bpm, order 2) and `ui-widget-power-heart-rate-ratio` (`widget-power-heart-rate-ratio`, W/bpm with two decimals, order 3) follow the Phase 3 widgets: same test ids (`value`, `unit`, `reason`, `data-status`), same display rules, one subscribed metric event each. `ride-with-heart-rate.feature` runs `startRidrsApp` with the `simulated-ride` fixture (trainer and heart-rate band).

## Phase 5 widgets

`ui-widget-virtual-speed` (`widget-virtual-speed`, km/h with one decimal, order 4) and `ui-widget-virtual-distance` (`widget-virtual-distance`, km with two decimals, order 5) show the virtual rider of the physics engine (see [physics.md](physics.md)). They subscribe to `physics.state` instead of a metric event, use the same test ids (`value`, `unit`, `data-status`) and show an en dash before the first state. Both round with `formatDecimal` from `@ridrs/ui-sdk`, the half-up formatter `describeMetricReading` uses too; no widget rounds on its own. The activity session starts and stops the simulation through `activity.state-changed`. `ride-with-virtual-speed.feature` runs `startRidrsApp` with the `simulated-trainer` fixture.

## Phase 7: a frame-driven landscape

`ui-landscape-flat` (replaced by `ui-landscape-demo` in Phase 10) subscribes to `physics.state-batch` (and `activity.state-changed`, to log presentation stats at ride finish) instead of `physics.state`. It creates one presentation from `@ridrs/presentation` and moves its lane markings every frame of `ctx.frames` by the presented distance (dash period 8 m). Its SVG exposes `data-distance` and `data-basis`; the lane markings keep `data-position`. The HUD widgets stay on `physics.state` at 4 Hz. `ride-with-moving-road.feature` runs `startRidrsApp` with the `simulated-trainer` fixture and a 60 FPS timer frame source. See [presentation.md](presentation.md).

## Phase 10: the landscape as the world's sensor

The demo landscape lives in the UI: `ui-landscape-demo` owns its model (the course of ADR 0027 and the surface, alternating every 500 m between asphalt and gravel), draws it and tells the host what it shows ahead, so what the rider sees is what the physics rides ([ADR 0044](../decisions/0044-ui-landscape-as-world-sensor-and-spatial-layer.md), amended 2026-11-04).

- **Drawing.** Every frame, at the presented distance, the road from 4 m to 160 m ahead in sections split where the surface changes, asphalt and gravel in different colours (the farthest section reaches the horizon); the lane markings on top, unchanged, with `data-position`. Without a state it draws at 0 m. For tests the SVG (`landscape`) carries `data-surface` (the surface under the rider) besides `data-distance` and `data-basis`, and each section in the `road` group `data-surface`, `data-from`, `data-to`.
- **Reporting.** The raw event `ui.terrain-observed` (declared in `ui.events.publish`, carried by the UI bridge as an input): `{ revision, originDistance, spacing, samples: [{ gradient, surface }] }`, 20 m from the whole metre at or before the presented odometer, 1 m apart. The landscape is mounted only on the activity screen, after the ride runs: on mount it publishes the window from 0 m at once (every ride starts there), then a new one whenever less than 10 m are left ahead of the presented position of the running ride; at standstill nothing. Frames of another session (the bridge replays the last batch of the previous ride) are ignored. `TerrainPublisher` holds the rules, `road-sections.ts` the drawing geometry, `landscape-model.ts` the model; all three are pure and unit-tested.
- **Path.** `world-driver-ui` validates the window and accepts it as `world.terrain-preview`; `spatial-terrain` writes it into `@ridrs/spatial`; the physics reads it there ([spatial.md](spatial.md)). The landscape never writes simulation state (AGENTS.md rule 10): frame timing reaches the physics only through input timing. When frames stop for long (window hidden, app in the background), no window arrives, the physics holds the last sample and reports one `terrain-preview-missing`.
- **Tests.** `ui/demo-landscape.feature` (`@ui`, in-process shell): asphalt to the horizon at the start, gravel after 500 m and asphalt after 1 km with a probe standing in for the odometer, and the window reaching the physics' reader. `apps/ride-on-the-demo-landscape.feature` (`@ui` e2e): one window from 0 m at the ride start and none at standstill, new windows while riding below half left, all accepted. The `terrain-observer` fixture records what the landscape published in the e2e app.

## Device indicator and setup

Device plugins say which kind of device they connect: `kind` (`trainer`, `heart-rate`, `controller`) on `device.connection-changed`, optional so early recordings stay valid. The headless `device-registry` turns those states into `device.status-changed`, the latest state of every reported kind in kind order, with the link that carries the device (`route`), the devices of that kind found (`candidates`, from `device.candidates-changed`) and the links over which device plugins look for more (`scanning`, from `device.scan-changed`, joined over all plugins of the kind). The bridge replays only the latest envelope per event, so a component that mounts later needs the whole picture in one event, not the last device that changed.

`ui-devices` contributes the **device indicator** to the new `main/status` extension point of the main screen (above Start ride) and offers the screen `setup`. The indicator shows one dot per kind (trainer, power, heart rate). The trainer measures power too and is the only power source so far, so the power dot and row show the trainer, the same way as in its own (searching while it is searched for). Without any device, the indicator reads "Set up your devices". A click opens `setup`: one row per kind with the device name and a status (`role=status`). Continue, or Done once everything is connected, leads back to `main`; nothing there blocks a ride. Conflicts, "not found" timeouts and the start-up flow of [docs/ux-draft](../ux-draft/README.md) are not part of this yet. `device-indicator.feature` and `device-status.feature` cover it.

The second line of a row is the device's name once one is known, else examples of fitting devices. When more devices of the kind were found, the row shows "+N" beside its title. While a kind searches without a device, its row counts every device of the kind found ("2 found", a forgotten one too) beside the status instead. A click on a row shows its **details** in place of the rows, with a round Back button at the top left (Back keys work like it) and no Continue: at the top right a pill that says whether ridrs looks for devices of the kind ("Searching…" while `scanning` in `device.status-changed` names a link, else "Not searching"); the kind's icon, title and one short sentence on what it is for; then the current device as one card, its top laid out like a device found: icon, name, a line with its link ("Over Bluetooth", "Over companion"; on the power row "Smart Trainer over Bluetooth"), the link's icon and signal bars, and its status as its row has it (the check, the reading such as "72 bpm", held controller buttons); below that only the facts the top does not show, at most two per line and never wrapped (for the companion the reason of its state); a one-line tip while the state needs the rider (searching, reconnecting; for the companion also not reachable with the reason's hint, pairing failed); then Remove (a red button with a bin icon) while the device is connected or tried (`device.forget-requested`: no device of the kind connects on its own until a device setup opens again), Connect once it is disconnected, and "Switch to companion" (or "Switch to Bluetooth") while the current device is seen over the other link too (`sameDeviceAs`); and every other device of the kind found, the strongest signal first when the details open (then the rows keep their order and devices found meanwhile follow) with four signal bars and the icon of its link (Bluetooth for Direct, a phone for Companion), each with Connect (not for the controller pair). A device both links see (`sameDeviceAs`) is one box that names it once: on top its row over this device's Bluetooth, below a quieter line per other link; connecting it over the other link switches the link. Every Connect names its link ("Connect with Bluetooth", "Connect with companion"); the devices the companion found are listed, counted and connectable only while `bridge.state-changed` says `connected`, and a disconnected device of the companion offers no Connect until then. Connect and Remove (and Connect of the companion) return to the rows as well. While `setup` is open it publishes `device.discovery-requested` (`active` on mount, not on unmount), so the device plugins keep looking. With the companion transport running (`bridge.state-changed`), the setup has a **Companion App** row of its own; its details show the companion's name and status in a card like a device's (no warning icon beside its status while it is not connected, in its row neither) with Connect or Try again and Remove, red with a bin icon as for a device (it forgets the companion; the details stay open and show the pairing again; no Disconnect: the phone can disconnect, ridrs forgets), and while nothing is paired the extension point `setup/companion`, where `ui-bridge-pairing` contributes two ways side by side: Scan the QR code, or Enter the code (six digits, the sixth pairs) of a companion found on this Wi-Fi. The rider's choices last for this run: **persisting them waits for the storage design** ([ADR 0042](../decisions/0042-device-links-in-the-peripheral-link.md)). `device-details.feature` covers it.

A controller is optional gear: its row (after heart rate) appears only once a controller was found (its status has a device id), and a controller still searched for does not hold up "Everything is connected". The indicator keeps its three dots. While a device is connected, its status proves that it works, from the device of that row only: the power row shows the watts of `measurement.power` and the heart-rate row the bpm of `measurement.heart-rate` in place of "Connected". On the controller row, the buttons held down on either controller of the pair (`controller.buttons-changed`) take the place of the check, one badge each with a symbol (arrows ← ↑ → ↓, A B Y Z, + − ⚡ ⏻) and its name for screen readers. The status is right-aligned with its icon last, so all icons stand in one column. `device-setup-proof.feature` covers it.
