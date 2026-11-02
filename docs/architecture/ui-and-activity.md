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
         ├─ activity/landscape  ◄─ ui-landscape-flat
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
| ids | `globalThis.crypto.randomUUID()` | same |

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

- **`@ridrs/ui-sdk`** (Apache-2.0, imports contracts only): `UiComponent = (container, ctx) => cleanup | void`, the `UiContext` (`events.subscribe/publish` limited to the plugin's own declared events, `slot(point, container)`, `navigate(path)`), the `UiBridge` port, and the shared metric display rules (`describeMetricReading`: values rounded half up to their unit's precision - `W`, `rpm`, `bpm` whole numbers, `W/bpm` two decimals; reasons `no source`, `disconnected`, `no signal`, `warming up`).
- **`@ridrs/ui-shell`**: plain DOM, no framework. Renders exactly one screen (`main` first, else the alphabetically first), mounts each contribution in a wrapper `data-contribution="<pluginId>/<contributionId>"`, keeps slots in sync with the registry without remounting unchanged contributions, and releases everything a component obtained through its context when it unmounts. A component that fails to load or throws is isolated: its wrapper stays empty and the shell reports `client-load-failure`. Navigation is deferred by a microtask, so components may navigate from their own handlers.
- **`@ridrs/ui-bridge`**: `createInProcessUiBridge(host, events)`. Enforces the allow-list (`event-not-allowed`), publishes on behalf of client code with the source `ui-bridge` (payloads validated by the bus: `invalid-event-payload`), and replays the **latest envelope per event** to every new subscriber, so a reloaded or second UI knows the current ride state and metric values. It is created before `host.start()`.

A remote bridge (the deferred `ui-gateway-web`, WebSocket) would implement the same `UiBridge` port; neither the shell nor any UI plugin would change.

## Layering

`ui-activity-screen` stacks its two slot containers absolutely in one stacking context: `activity/landscape` (z 0), `activity/hud` (z 1, `pointer-events: none`), and its own **Finish ride** button (z 2). `ui-hud` lays out `hud/widget` in the lower corners and lets pointer events through except on widgets. Screens navigate on `activity.state-changed`, not on clicks: `running` leads to `activity` (including the replayed state after a reload), anything else back to `main`.

## Activity session

`activity-session` publishes `{ state: 'idle' }` on start, moves to `running` (new `sessionId` from `globalThis.crypto.randomUUID()`, `startedAt` from the injected clock) on `activity.start-requested` and to `finished` on `activity.finish-requested`. Any other transition is an `invalid-transition` diagnostic with no event. A ride never needs a trainer.

## Tests

- Registry, activity and bundled discovery: Cucumber through the real host with probe plugins.
- `transport-ble-tauri`: Cucumber against a simulated Tauri bridge (`@tauri-apps/api/mocks` + `BleSimulator`), plus Vitest unit tests.
- Composition and the vertical use case: Cucumber `@ui` scenarios run the real host, bridge, shell and UI plugins in happy-dom (profile `ui`); `ride-in-native-app.feature` uses the native app's own composition root `startRidrsApp` with the simulated trainer.

## Phase 4 widgets

`ui-widget-heart-rate` (`widget-heart-rate`, bpm, order 2) and `ui-widget-power-heart-rate-ratio` (`widget-power-heart-rate-ratio`, W/bpm with two decimals, order 3) follow the Phase 3 widgets: same test ids (`value`, `unit`, `reason`, `data-status`), same display rules, one subscribed metric event each. `ride-with-heart-rate.feature` runs `startRidrsApp` with the `simulated-ride` fixture (trainer and heart-rate band).

## Phase 5 widgets

`ui-widget-virtual-speed` (`widget-virtual-speed`, km/h with one decimal, order 4) and `ui-widget-virtual-distance` (`widget-virtual-distance`, km with two decimals, order 5) show the virtual rider of the physics engine (see [physics.md](physics.md)). They subscribe to `physics.state` instead of a metric event, use the same test ids (`value`, `unit`, `data-status`) and show an en dash before the first state. Both round with `formatDecimal` from `@ridrs/ui-sdk`, the half-up formatter `describeMetricReading` uses too; no widget rounds on its own. The activity session starts and stops the simulation through `activity.state-changed`. `ride-with-virtual-speed.feature` runs `startRidrsApp` with the `simulated-trainer` fixture.
