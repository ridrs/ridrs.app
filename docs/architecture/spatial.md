<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# Spatial Data Layer (Phase 10)

The temporal data layer holds quantities by time; the spatial data layer holds quantities by **distance along the path**, the physics odometer in metres. The first series is the terrain: gradient and surface. Decision: [ADR 0044](../decisions/0044-ui-landscape-as-world-sensor-and-spatial-layer.md) (amended 2026-11-04).

```text
sensors              drivers                         interpolation layer                       physics
trainer        ─►  device plugins     ─► measurement.* ─► metric-* writers ─► @ridrs/temporal ─► readers: valueAt(t)
UI landscape   ─►  world-driver-ui    ─► world.terrain-preview ─► spatial-terrain ─► @ridrs/spatial ─► readers: valueAt(distance)
(ui.terrain-observed, via the UI bridge)        (input: recorded, injected on replay)
```

**Constraint: data never reaches the physics by event.** Physics plugins (`plugins/physics-*`) read input data only through readers (`ctx.temporal`, `ctx.spatial`) and subscribe to `activity.*` only (AGENTS.md rule 11; enforced by `tests/unit/physics-plugins.test.ts`). Data events go to drivers and writers.

## Parts

| Part | Role |
|---|---|
| `@ridrs/spatial` (`packages/spatial`, AGPL-3.0-or-later) | Pure, deterministic sampling: `SpatialSeries` (newest window, revisions per source, interpolation per channel). No clock, no library, type-only contracts. |
| `ctx.spatial` (`packages/core/src/spatial-service.ts`) | Series registry and ownership; writes only inside turns and by a started writer; a stopped writer's series has no source any more. |
| Contracts (`packages/contracts/src/spatial.ts`, Apache-2.0) | `SpatialValue`, `SpatialWindow`, `SpatialSeriesWriter/Reader`, `PluginSpatialContext`, `TerrainPoint`, capability `spatial.terrain` (`single`). |
| `spatial-terrain` (type `spatial`) | The one writer of `spatial.terrain`: subscribes to `world.terrain-preview`, applies the asphalt default, writes each window. However many worlds feed it, there is one writer. |
| `world-driver-ui` (type `transport`) | Validates `ui.terrain-observed` and accepts a valid window as the input `world.terrain-preview` (see below). |
| `ui-landscape-demo` (type `ui`) | The sensor: owns, draws and reports the demo landscape ([ui-and-activity.md](ui-and-activity.md)). |

Plugins never import `@ridrs/spatial` (dependency-cruiser `plugins-never-import-spatial`); `packages/spatial` imports contracts for types only and nothing else.

## API

- `ctx.spatial.writer(capability, { channels })`: only for a capability the plugin `provides`, only during `initialize`, one writer per series. `channels` says per channel how it interpolates: `linear` (numbers) or `step` (categories). The plugin also provides the capability, with the same channels.
- `ctx.spatial.reader(capability)`: for a capability in `requires`, or the plugin's own series.
- `writer.write({ sourceId, revision, originDistance, spacing, samples })` → `accepted` | `outdated`. Sample `i` lies at `originDistance + i · spacing`.
- `reader.valueAt(distance)` → `{ status: 'available', distance, value, quality: 'sampled' | 'interpolated' | 'held', sourceId, revision }` or `{ status: 'unavailable', distance, reason: 'no-source' | 'outside-window' }`.

## Semantics

- A window **replaces** the range it covers; nothing outside the newest window is kept (a window always starts at or behind the rider). A lower or equal revision from the same source is ignored (`outdated`); revisions count per source.
- **Per channel:** `gradient` linear between samples; `surface` stepwise, a sample's value holds until the next sample.
- Exactly on a sample: `sampled`. Between two: `interpolated`. Beyond the window's end: `held`, the last sample's values. Before any window: `no-source`; behind the window's origin: `outside-window`.
- **Reading ahead** is allowed, as far as the window goes. There is **no ageing**: terrain does not go stale at standstill.

## The driver's validation

`world-driver-ui` subscribes to `ui.terrain-observed`, `physics.state-batch` (the odometer of the running ride) and `activity.state-changed` (to know whether a ride runs; 0 m between rides). A window is valid if `originDistance` is finite, ≥ 0 and at or before the latest odometer; `spacing` > 0; at least two samples; every gradient finite and within ±0.30; every surface `asphalt` or `gravel` (or none); and its revision a whole number above the source's last one. An invalid window is dropped with `terrain-preview-rejected` (`reason`: `invalid-origin`, `origin-ahead-of-rider`, `invalid-spacing`, `too-few-samples`, `invalid-gradient`, `unknown-surface`, `revision-not-ascending`; `revision`, `source`). A valid one goes out through `ctx.inputs.accept(worldTerrainPreviewEvent, …)`.

A replay leaves the driver out (type `transport`) and injects the recorded `world.terrain-preview` inputs: the replay is deterministic without UI plugins. The raw `ui.terrain-observed` events are recorded too and injected opaquely; nothing listens to them on replay.

## Tests

- Vitest: `packages/spatial/src/spatial.test.ts` (every rule above), `plugins/world-driver-ui/validate.test.ts` (every rejection, including non-finite values that JSON cannot carry).
- Cucumber: `tests/features/spatial/spatial-layer.feature` (a probe writer and reader), `tests/features/world/world-driver-ui.feature` (valid and invalid windows, the odometer between rides, the asphalt default).
