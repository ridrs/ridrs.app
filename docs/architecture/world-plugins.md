<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# Feeding the World: Sensors and Drivers

A **world** knows the terrain; the **physics** knows how far the rider went. Since Phase 10 the world is not a host plugin that publishes events to the physics: it is a **sensor** whose observations a **driver** validates and turns into the input `world.terrain-preview`. The writer `spatial-terrain` puts every accepted window into the spatial data layer, where the physics reads it. This page is for developers who add a world: a route, a terrain, a test course. Decision records: [ADR 0044](../decisions/0044-ui-landscape-as-world-sensor-and-spatial-layer.md) (amended 2026-11-04), [ADR 0043](../decisions/0043-terrain-preview-by-event.md); the layer: [spatial.md](spatial.md); the physics side: [physics.md](physics.md).

```text
sensor (e.g. ui-landscape-demo) ──► ui.terrain-observed ──► driver (world-driver-ui) ──► world.terrain-preview (input)
   presented odometer                (raw, via the UI bridge)    validates; odometer from          │
   (physics.state-batch)                                         physics.state-batch               ▼
                                                                                spatial-terrain ──► @ridrs/spatial ──► physics reader
```

The reference sensor is `plugins/ui-landscape-demo` (model, drawing, `TerrainPublisher`); the reference driver is `plugins/world-driver-ui`.

## The contract

`packages/contracts/src/world.ts` (Apache-2.0):

```ts
interface TerrainPreview {
  revision: number;        // integer ≥ 1, counts up with every window a source publishes
  originDistance: number;  // m, the physics odometer reading of samples[0], ≥ 0
  spacing: number;         // m between two samples, > 0
  samples: { gradient: number; surface?: 'asphalt' | 'gravel' }[]; // at least two; no surface = asphalt
}
```

- Sample `i` lies at the odometer reading `originDistance + i · spacing`.
- `gradient` is rise over run along the rider's path, dimensionless: `0.05` is 5 % uphill. Across a hillside, it is the slope along the direction of travel, not the slope of the hill.
- The spatial layer interpolates the gradient **linearly** and holds the surface from one sample to the next; beyond the last sample it holds the last one.
- `ui.terrain-observed` has the same shape but is only shape-checked: the driver decides what is valid.

## The rules

1. **Distances are the physics odometer, not your coordinates.** Every ride starts at 0 m. Convert positions along the path the rider follows into odometer metres; never the other way.
2. **Read the odometer, never integrate it.** A UI sensor takes the presented distance (`@ridrs/presentation`), a host-side sensor the last sample of `physics.state-batch` of the running ride.
3. **The first window from 0 m.** The demo landscape publishes it when it is mounted for the ride. Step 0 comes before it and rides the default (flat asphalt); that gap is expected and reports nothing.
4. **The next window before the current one runs out**: when less than half (10 m) is left ahead of your odometer reading.
5. **Nothing at standstill**, and never on a timer.
6. **Use a fixed grid.** Start each window at the grid point at or before the odometer (`Math.floor(d / spacing) · spacing`), so every distance gets the same terrain whichever window covers it.
7. **Ignore other rides.** A UI subscriber gets the last envelope replayed: the last batch may be the previous ride's.
8. **Through a driver, as an input.** Only a driver (type `transport`) accepts `world.terrain-preview`, with `ctx.inputs.accept`. It validates: origin finite, ≥ 0 and at or before the latest physics odometer (0 between rides); spacing > 0; at least two samples; gradients finite and within ±30 %; known surfaces; revisions strictly ascending per source. Invalid windows are dropped with `terrain-preview-rejected`.
9. **Never reach the physics directly.** No plugin publishes terrain to a physics plugin, and physics plugins subscribe to `activity.*` only (AGENTS.md rule 11).
10. **Imports.** A UI sensor imports contracts, `@ridrs/ui-sdk` and `@ridrs/presentation`; a driver only `@ridrs/contracts`. No imports between plugins (dependency-cruiser).

## Choosing the numbers

The demo landscape uses `TERRAIN_WINDOW = { windowLength: 20, spacing: 1, republishBelow: 10 }`:

- A UI sensor sees the odometer about 80 ms late (presentation delay plus a frame). At 25 m/s that is 2 m; with 10 m left as seen by the UI, at least 8 m are really left: four times the lag ([ADR 0044](../decisions/0044-ui-landscape-as-world-sensor-and-spatial-layer.md)).
- When frames stop for long, no window arrives: the physics holds the last sample and reports one `terrain-preview-missing`. The terrain then depends on input timing, never on the frame rate otherwise.
- A spacing of about 1 m is below a bike length; smooth noisy source data to about one bike length.

## What the physics does with your windows

- It reads `spatial.terrain` once per step at the previous step's distance and validates the gradient (finite, within ±30 %). An invalid gradient fails the ride's physics with `physics-step-failed` naming the window's source.
- Before the ride's first window: flat asphalt, silently. After it, a gap (beyond the window: `held`; behind its origin: `unavailable`) is reported once as `terrain-preview-missing` with `distance`, `at`, `reason` and the road that holds.
- Headless has no sensor: its rides are flat on asphalt.

## Replay

The accepted windows are inputs: a recording keeps them and a replay injects them; the driver and UI sensors do not run on replay. A changed landscape model is therefore not detected by a replay, like a changed trainer firmware ([recording-and-replay.md](recording-and-replay.md)).

## Testing

- **Vitest** for the pure logic: the model at boundaries, the window on the grid, when to publish (`TerrainPublisher`), the driver's validation (`plugins/world-driver-ui/validate.test.ts`).
- **Cucumber**, physics (`@fake-timers`): mock worlds from `tests/steps/terrain.steps.ts` feed windows through the same input path (`a mock world "…" feeds the terrain ahead with a constant gradient of … % when the ride starts`, `… feeds the demo landscape`).
- **Cucumber**, UI (`@ui`): `ui/demo-landscape.feature` with a probe odometer; `apps/ride-on-the-demo-landscape.feature` with the `terrain-observer` fixture, which records what the sensor published in the e2e app.

## Checklist

- [ ] A sensor that knows the terrain and reads the odometer; a driver that validates and accepts inputs.
- [ ] First window from 0 m; next windows below half left; nothing at standstill or from timers.
- [ ] Origins on a fixed grid at or before the odometer; at least two samples; revisions count up.
- [ ] Gradients along the path, smoothed, within ±30 %; surfaces `asphalt` or `gravel`.
- [ ] Unit tests for the model and the publishing rules; a scenario that rides it without `terrain-preview-rejected`.
