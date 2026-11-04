<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0044: The UI Landscape as World Sensor, `@ridrs/spatial`, and Data Never by Event into the Physics

Status: accepted by the maintainer on 2026-11-04; implemented in Phase 10 with the amendment of the same day (see the end), which takes precedence where the two differ. Supersedes the world and consumer parts of [ADR 0043](0043-terrain-preview-by-event.md) (`physics-road` as host world, the subscription in `physics-virtual-speed`). Keeps from ADR 0043: the event `world.terrain-preview` in metres along the path, anchored at the physics odometer, the 1 m grid, linear gradient interpolation and the replay rule "not in recording". Amends AGENTS.md rule 10 and adds rule 11 (wording approved by the maintainer, see the end).

## Context

The demo world gets a second property along the path: the surface, alternating asphalt and gravel, which the rider sees and feels (rolling resistance). With a second quantity by distance, the interpolation that ADR 0043 put into the integrator becomes a shared layer, as the temporal data layer is for quantities by time. At the same time, the maintainer decided where the landscape lives: in the UI, which draws it and therefore knows it, not in a host-side course next to it.

## Decision

### Layers

```text
sensors              drivers                         interpolation layer                      physics
trainer        ─►  device plugins     ─► measurement.* ─► metric-* writers ─► @ridrs/temporal ─► readers: valueAt(t)
UI landscape   ─►  world-driver-ui    ─► world.terrain-preview ─► spatial-terrain ─► @ridrs/spatial ─► readers: valueAt(distance)
(ui.terrain-observed, via the UI bridge)
```

- **Constraint: data never reaches the physics by event.** Physics plugins (`plugins/physics-*`) read input data only through readers of the interpolation layer (`ctx.temporal`, `ctx.spatial`). They subscribe to lifecycle events only (`activity.*`). Data events go to drivers and writers. Feedback through events and turns is allowed: the landscape reads the odometer from `physics.state-batch` and its window comes back as an input. Enforced by a unit test over every `plugins/physics-*` (subscriptions limited to `activity.*`), next to the existing contributor test.

### Sensor: the UI landscape

- `ui-landscape-demo` (successor to `ui-landscape-flat`, type `ui`) owns the demo landscape model: the gradient course of ADR 0027 (2 km flat, 1 km +5 %, 500 m flat, 1 km −5 %, flat) and the surface, alternating **3 km asphalt, 1 km gravel** from 0 m (asphalt `[0, 3000)`, gravel `[3000, 4000)`, asphalt `[4000, 7000)` …). It draws the road from the same model: asphalt and gravel in different colours, section by section to the horizon, at the presented position (as the lane markings are drawn today).
- It publishes the raw event **`ui.terrain-observed`** (declared in `ui.events.publish`, carried by the UI bridge) with the same shape as the contract event: `{ revision, originDistance, spacing, samples: [{ gradient, surface }] }`, 20 m from the whole metre at or before the **presented** odometer, 1 m spacing.
- **When.** (1) While no ride runs (on mount, at `idle` and after `finished`): one window from 0 m, because every ride starts at 0 m. This is the window step 0 uses: a window the UI publishes in reaction to `running` arrives several turns later (bridge, frame) and could never be there for step 0. (2) During a ride: when less than 10 m of the current window is ahead of the presented odometer. At standstill nothing goes out.

### Driver: `world-driver-ui`

- New plugin, type `transport` (an existing input-side type: its publications are inputs, and a replay leaves it out, so it does not run twice next to the recorded inputs; no new type in the core).
- Subscribes to `ui.terrain-observed` and `physics.state-batch` (for the odometer). It validates each window: `originDistance` finite, ≥ 0 and at or before the latest physics odometer of the running ride (0 between rides); spacing > 0; at least two samples; every gradient finite and within ±0.30; `surface` ∈ {`asphalt`, `gravel`}; revision strictly ascending per source. An invalid window is dropped with the diagnostic `terrain-preview-rejected` (new code; details: reason, revision). A valid one is published as **`world.terrain-preview` through `ctx.inputs.accept`**: an external input (`input: true`), recorded and injected on replay.
- The replay therefore stays deterministic without UI plugins: it injects the recorded windows at their recorded times. The raw `ui.terrain-observed` events are recorded too (inputs from the UI bridge) and injected opaquely; nothing listens to them on replay.

### Interpolation layer: `@ridrs/spatial`

- New package `@ridrs/spatial` (AGPL-3.0-or-later, like `@ridrs/temporal`; contracts in `@ridrs/contracts`, Apache-2.0), wired by the core like the temporal layer: `ctx.spatial.writer(contract)` and `ctx.spatial.reader(contract)`. Own code, no library: windowed sampling and the interpolation rules are ridrs domain logic.
- **Series identity and ownership** through a capability, like `metric.*` for time series: `spatial.terrain` (`single`), provided by the writer plugin **`spatial-terrain`**, which subscribes to `world.terrain-preview` and writes each window. There is exactly one writer, however many worlds feed it events, so the `single` cardinality does not block several worlds (the concern of ADR 0043).
- **Semantics** (distance axis = physics odometer, m):
  - A window **replaces** the range it covers; a lower or equal revision from the same source is ignored. Ranges outside the newest window are not kept (a window always starts at or behind the rider).
  - **Per channel:** `gradient` linear between samples; `surface` stepwise, a sample's value holds until the next sample (categorical values do not interpolate).
  - Reading ahead is allowed (that is the point). There is no ageing: terrain does not go stale at standstill.
  - Result like `TemporalValue`: `{ status: 'available', value, quality: 'sampled' | 'interpolated' | 'held', sourceId, revision }` or `{ status: 'unavailable', reason: 'no-source' | 'outside-window' }`. Beyond the window's end the reader answers `held` with the last sample's values; before any window, or behind a window's origin, `unavailable`.
- **`world.terrain-preview`** gains `surface` per sample: `'asphalt' | 'gravel'`, optional; **absent means asphalt** (applied by the writer). This keeps windows without surface (tests, older inputs) valid, and replays of them ride on asphalt.

### Physics

- `physics-virtual-speed` drops its subscription and `terrain.ts` (the interpolation moves to `@ridrs/spatial`) and reads `ctx.spatial.reader(spatialTerrainCapability)` once per step at the previous distance. It requires `spatial.terrain`. Missing values: `held` is used as given; `unavailable` → flat asphalt at the ride start, else the last values used; `terrain-preview-missing` once per gap, with the reader's reason. An invalid gradient still fails the step, naming the reader's `sourceId`.
- `RoadSample` gains `surface` (`physics.state.road.surface`, zod-validated). `ResistanceInput.road` carries it.
- **Crr by surface.** `physics-rolling-resistance` multiplies the bicycle's coefficient (the tyre on asphalt, 0.004) by a surface factor: **asphalt 1.0 → 0.004, gravel 2.0 → 0.008** (`ROLLING_DEFAULTS.surfaceFactors`, in its configuration snapshot). The bicycle stays the owner of the tyre; the surface only scales it. Expected at 200 W on flat gravel: about **32.2 km/h** (34.2 km/h on asphalt): `200 = 0.008 · 85 · 9.81 · v + ½ · 1.225 · 0.32 · v³` → v ≈ 8.95 m/s. To be confirmed by measurement in the implementation.
- `physics-engine` keeps step 0 as a task at `startedAt` (ADR 0043). It is no longer what makes the first window available (the pre-ride window is), but it is harmless and keeps the start order independent of plugin order.

### Window numbers on this path

The UI sees the odometer through the presentation, 60 ms in the past, plus up to one frame (≈ 17 ms at 60 Hz). The bridge and the two inputs (raw and contract event) add less than a millisecond in process: about **80 ms** behind the physics. At 25 m/s (90 km/h; the demo maximum is about 58 km/h) that is 2 m. With **20 m windows republished below 10 m left** as seen by the UI, at least 8 m are really left: 320 ms at 25 m/s, four times the lag. Numbers unchanged from ADR 0043.

Consequence of a UI sensor: when frames stop (window hidden, app in the background, a long UI stall: more than about 0.3 s at 25 m/s, 0.8 s at 34 km/h), no window arrives, the reader holds the last values, and the physics reports one `terrain-preview-missing`. Intended: the terrain then depends on input timing, never on the frame rate otherwise.

### Headless and tests

- **Headless is always flat:** without a UI no terrain arrives; the physics rides flat on asphalt and reports `terrain-preview-missing` once per ride (`no-source`). Intended behaviour, documented in physics.md and the README, not an error.
- **Physics BDD scenarios bring their own world:** a test-only mock world (probe) feeds windows through the same input path (`ctx.inputs.accept` of `world.terrain-preview`, including the pre-ride window). Scenarios that depend on the demo course get it from a mock world with the demo model; expected values stay unchanged (including ADR 0043's boundary values 25.51 km/h and 2375.63 m).
- **e2e (`@ui`)** use the real `ui-landscape-demo`, or a UI fixture landscape with a short climb (successor of `fixture-road-short-climb`).

### Recording and replay

- `recording-session` keeps the **latest `world.terrain-preview` older than the pre-roll**, as it keeps the latest connection state per device. The pre-ride window may be published minutes before the ride, and step 0 must find it on replay too.
- Recordings made before this change have no terrain inputs. The "not in recording" rule of ADR 0043 stays. Recordings that relied on the host world `physics-road` replay **without** a host world from now on: the plugin is reported as missing, the physics rides flat, and on the climbs it differs from the recording. Recordings with ADR 0043's derived (non-input) windows exist only from development; they report the `world.terrain-preview` stream of `physics-road` as missing.
- Windows without `surface` replay on asphalt.

### Removed

`physics-road` (host world and demo course), `ui-landscape-flat` (replaced), `plugins/physics-virtual-speed/terrain.ts`, and the subscription of `physics-virtual-speed`.

### AGENTS.md wording (approved by the maintainer on 2026-11-04; applied by the implementation)

> 10. **Rendering reads, never drives.** Rendering never writes simulation state directly; frame rate never changes physics results except through input timing. A UI plugin may act as a sensor: it delivers world data as an external input through a driver, like a device.
>
> 11. **Layers.** Sensors → drivers → interpolation layer (`@ridrs/temporal`, `@ridrs/spatial`) → physics. Physics plugins read input data only through readers; they subscribe to lifecycle events (`activity.*`) only, never to data events.

## Consequences

- One source of truth for the landscape: what the rider sees is what the physics rides.
- The physics no longer subscribes to data; `physics-virtual-speed` is a pure contributor again, and the subscription rule is checkable.
- The terrain is an input, not a derived event: replays reproduce it from the recording, and a changed landscape model is not detected by a replay (like a changed trainer firmware).
- Headless rides are flat. A host-side world (route file, map) later is a sensor plus driver like the UI, without changes to the layer or the physics.
- New parts: one package, three plugins (`ui-landscape-demo`, `world-driver-ui`, `spatial-terrain`), one capability, two events (`ui.terrain-observed`, `world.terrain-preview` with surface), one diagnostic code.

## Amendment (decided by the maintainer on 2026-11-04, during the implementation)

**Ride start on the default terrain; the landscape reports on mount.** Changes "Sensor: the UI landscape → When" and "Physics".

- *Context.* The landscape is a contribution to the activity screen, which is mounted only once the ride runs. It cannot report a window "before the ride"; step 0 always comes before its first window.
- *Physics.* Until the first window of a ride, `physics-virtual-speed` rides the default flat asphalt (`origin: 'default'`). That gap at the ride start is expected and reports nothing. `terrain-preview-missing` is reported only for a gap after the ride's first window (`held` or `unavailable`), once per gap; a `held` value is used as given and reported with `reason: 'outside-window'`, `quality: 'held'`.
- *Landscape.* `ui-landscape-demo` reports the window from 0 m as soon as it is mounted, without waiting for a physics state (every ride starts at 0 m), then as before: a new window when less than 10 m are left ahead of the presented position, nothing at standstill. Without a state it draws at 0 m.
- *Dropped.* The window "before the ride" (on mount, at `idle`, after `finished`) and the pre-roll rule in `recording-session`: every terrain window of a ride lies within the ride.
- *Consequence.* A future course that does not start flat on asphalt switches from the default to its real values after a few steps (millimetres); accepted. Should it matter, an app-wide sensor slot in the shell is the extension.
- *Headless.* A headless ride never gets a window: it stays flat on asphalt and reports nothing (decided by the maintainer on 2026-11-04). This replaces "once per ride (`no-source`)" in "Headless and tests" above.
- *Also decided.* Replay compatibility with older recordings is not a goal in early alpha: recordings whose `physics.state.road` has no `surface` are rejected by the replay (`invalid-recording`).
- *Surface pattern.* The demo surface alternates every **500 m** (asphalt `[0, 500)`, gravel `[500, 1000)`, repeating) instead of 3 km asphalt / 1 km gravel, so gravel shows up early in a ride (decided by the maintainer on 2026-11-04). The physics scenario of the demo climb rides the course without surfaces (asphalt), so its expected values stay unchanged.
