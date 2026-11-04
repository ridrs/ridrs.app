<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# Ideas: World, Lookahead and Elevation Profile

**Status: ideas only. Nothing here is decided or implemented.** This page collects the ideas and plans of a design session on 2026-11-03, so they are not lost. They are **optional future development**: each one is taken up only when a real use case of a phase needs it, and then designed in small steps with its own Cucumber scenarios and ADR (AGENTS.md rules 1, 3 and 9). The architecture documents in `docs/architecture/` describe only what exists.

**Update 2026-11-04:** section 4 (lookahead by distance) is implemented in its first step by [ADR 0043](../decisions/0043-terrain-preview-by-event.md) as `world.terrain-preview`; `physics.road` is gone and step 0 now runs as a task after the `running` turn. The facts below about step 0 and `physics.road` describe the code before that change.

Markers used below:

- **[Fact]** verified against the code on 2026-11-03; true today.
- **[Optional]** an idea for later; no decision.
- **[Leaning]** a preference the maintainer stated during the session; not a decision, to be revisited with the use case.

## 1. Facts about the current code (useful for any later design)

- **[Fact]** The event bus is synchronous run-to-completion FIFO (`queueScheduler`): an event published inside a handler is delivered after the current event has reached all subscribers, still in the same turn.
- **[Fact]** `physics-engine` runs one step per clock task and publishes `physics.state-batch` from inside every fifth step's task. A reaction to a batch reaches other plugins before the next step.
- **[Fact]** Step 0 (`motion.initial`, which already calls `physics.road.at(0)`) is computed inside `physics-engine`'s handler of `activity.state-changed` → `running`. Anything published in reaction to that same event arrives after step 0. `activity-session` switches to `running` directly in its handler of `activity.start-requested`, whose payload is empty and strict.
- **[Fact]** One physics step makes about eleven capability calls besides `physics.motion` (rider and bicycle parameters, powertrain, road, total resistance, three resistance providers, and the parameter reads of rolling resistance and aerodynamics). `multiple` providers come sorted by plugin id; `physics-total-resistance` sorts contributions by source again.
- **[Fact]** The recorder stores every published event and keeps a 60 s pre-roll before `running` (plus the latest connection state per device). Today about 4 `physics.state` and 20 `physics.state-batch` per second.
- **[Fact]** `metric.*` capabilities serve two roles: `latest()` (called by `output-console` and the Cucumber steps) and the series id and writer ownership in `ctx.temporal`.
- **[Fact]** Temporal layer: `valueAt(t)` with `t > now` is `out-of-range`; measurements are single numbers; every series goes stale, `hold` included (3000 ms while the interval is not learned); before the first write `no-source`.
- **[Fact]** Two providers of a `single` capability report `ambiguous-provider` and block both; zero providers are only reported if some plugin requires the capability.
- **[Fact]** The UI bridge replays the latest envelope per event id to new subscribers.
- **[Fact]** The FIT export writes `distance`, `speed` and `totalDistance`, no altitude and no position.
- **[Fact]** `RoadSample.origin` and `physics.state.road.origin` accept only the literal `'default'`.
- **[Fact]** The physics speed is forward-only; the distance never decreases.

## 2. Capabilities, events and time series

- **[Optional]** Keep synchronous capabilities for the simulation core (`physics.motion`, `physics.total-resistance`, `physics.resistance`, `physics.powertrain`): 100 Hz, one logical time per turn, deterministic order. Turning a call into a request and a response event would add about 200 recorded events/s per call, about 2400/s for all of them. Within a turn there is no latency cost; the cost is scatter-gather, missing providers and recording volume.
- **[Optional]** Rule of thumb: events for state changes, commands and pushed data; time series for values that change over time and are queried with age and quality.
- **[Optional]** Drop `metric.*.latest()` (the method only; the capability stays as series id).
- **[Optional]** Bicycle, rider and environment parameters as series once configuration is dynamic. Needs a series mode that never goes stale and a default before the first write.
- **[Optional]** `config.snapshot` and the bridge pairing storage (`loadPairing` / `savePairing`) could become asynchronous; results would enter through `ctx.inputs`.

## 3. A replaceable world

- **[Optional]** The physics stays one-dimensional: speed and odometer (distance travelled).
- **[Optional]** A world plugin (type `world`; variants: GPX route, road network, free 3D terrain) owns the pose (`x`, `y`, `z`, `heading`, `pitch`), never integrates distance (it takes the odometer delta from `physics.state-batch`) and turns steering into heading.
- **[Leaning]** Each world decides its coordinate frame and how rider input becomes steering.
- **[Leaning]** The world is chosen when the activity starts. Consequences: several world plugins may run side by side, so a `single` marker capability (`world.terrain`, first idea) would block them all; the choice needs a field in `activity.start-requested` or a selection event.
- **[Optional]** Further events: `world.pose-changed` (batched, for rendering, minimap, HUD), `rider.steering-changed` (if a world needs it).

## 4. Lookahead by distance (`world.ground-ahead`)

- **[Optional]** The world publishes the terrain ahead along the chosen path: `{ revision, originDistance, spacing (≈1 m), samples: [{ gradient, surface? }] }`, 10–20 m long, anchored at the physics odometer. The physics computes `s = odometer − originDistance` and interpolates linearly.
- **[Optional]** Why distance, not time: the terrain ahead does not depend on speed, so the world can publish it exactly; speed uncertainty stays with the physics. A forecast in time does not fit the temporal layer either (no future values).
- **[Optional]** Gradient along the direction of travel: crossing a hillside diagonally gives `hill slope × cos(angle to the fall line)`. Smoothing to about one bike length in the world.
- **[Optional]** Triggers: a first window from odometer 0; a new window (higher revision) on steering, rate-limited (e.g. 10 per second; open: drop or coalesce); the next window on a batch when less than half is left. No events at standstill.
- **[Optional]** Window length: the world sees the odometer every 50 ms (1 m at 20 m/s); 10 m has reserve, also for an asynchronous world (200 ms → 4 m).
- **[Optional]** Consumer: like the power input (`physics-powertrain` holds the reader, the integrator asks it), `physics-road` could keep the newest window behind the unchanged `physics.road` capability. It would be the first physics contributor with an event subscription.
- **[Leaning]** Fallback: hold the last gradient and report a diagnostic once per gap; flat (`0`) before the first window.
- **[Leaning]** First window as early as possible. Open conflict with "world chosen at activity start": loading then happens at the start, asynchronous loading (GPX, map) arrives in a later turn than `running`. Either a preparation phase (the activity waits for a generic "world ready", with a timeout) or the first steps run flat.
- **[Leaning]** World samples get their own `RoadSample.origin` value; the recording format changes.
- **[Leaning]** `surface` comes later from the world's map, where it makes sense.
- **[Optional]** Open: windows between rides (every ride starts at 0 m); a `sessionId` in the window only works if the window is published after `running`.

## 5. Two coordinates

- **[Optional]** Odometer (physics): distance driven; anchor of the lookahead, FIT `distance`, recording.
- **[Optional]** Route position or chainage (world): metres along the route's reference line; x axis of the elevation profile, "you are here" marker. Zigzag, U-turns and detours make the two diverge; never convert one into the other.
- **[Optional]** `world.route-position { chainage, offRoute }` at about 4 Hz by map matching: search only near the last chainage (loops, crossings), allow decreasing values (U-turns), keep the last value with `offRoute: true`, `null` without a route.

## 6. Elevation profile HUD

- **[Optional]** `world.route-profile`: same shape as the lookahead, coarse raster (25–50 m, hundreds of samples) of altitude by chainage; gradient for colouring derived. Published on load, route or branch change. Generated by the world from its own data, not from lookahead windows.
- **[Leaning]** Free terrain: a short projection along the current heading instead of a fixed profile.
- **[Optional]** The HUD lists the event in `ui.events.subscribe`; the bridge's latest-envelope replay gives a later-mounted HUD the profile at once.
- **[Optional]** Publish the profile at ride start, so it lies inside the recorder's 60 s pre-roll and appears once in the recording.

## 7. Later

- **[Optional]** Obstacles and boundaries: the world tells the physics "stop here".
- **[Optional]** Altitude and position in the FIT export. Open: the session also mentioned "the UI supplies the coordinates". Against it: the UI shows the physics 60 ms late and interpolated per frame, renders nothing headless or in the background, and its events would be external inputs a replay cannot recompute. Alternative: the world computes lat/lng/altitude from its pose (for a GPX route) and publishes them, where that makes sense.
