<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# Physics Engine (Phases 5, 6 and 10)

Phase 5 use case: **I pedal 200 W and ridrs shows my virtual speed.** Measured rider power moves a virtual rider of 85 kg in still air. The HUD shows speed and distance next to power and cadence.

Phase 6 use case: **The same power gives a different speed on a climb than on the flat.** The rider rides a built-in demo course; gravity opposes them uphill and pushes them downhill. The HUD shows the gradient. The physics grew only by adding plugins behind the existing capabilities: `physics-engine` and `physics-total-resistance` are unchanged.

Phase 10 use case: **the road the rider sees is the road the physics rides.** The demo landscape lives in the UI (`ui-landscape-demo`), which draws it and reports the terrain ahead; a driver turns that into an input, the spatial data layer holds it, and the physics reads it there. Gravel doubles the rolling resistance.

```text
event-driven:  trainer ─► device-ftms-trainer ─► measurement.power ─► metric-power ─► series metric.power (damped-trend)
                                                                                           │ reader.valueAt(t)
clock-driven:  activity.state-changed ─► physics-engine: running → step 0 as a task at t₀ = startedAt, step n every 10 ms (t = t₀ + 10·n); paused → no task; running again (`resumedAt`) → the next step at resumedAt + 10, the state unchanged (ADR 0056)
                                              │ motion.advance(previous, t)
                                              ▼
                                     physics-virtual-speed  (integrator: acceleration, speed, distance)
                                       │ wheelPower(t)    │ evaluate(t, v, m, road)    │ parameters()       ▲ reader.valueAt(xₙ): gradient, surface
                                       ▼                  ▼                            ▼                    │ series spatial.terrain (ctx.spatial)
                             physics-powertrain   physics-total-resistance     physics-bicycle ·    spatial-terrain ◄─ world.terrain-preview (input)
                             (η = 1.0, reads          │ getAll(physics.resistance)   physics-rider          ◄─ world-driver-ui ◄─ ui.terrain-observed
                              metric.power)           ├─► physics-rolling-resistance  (Crr · f(surface) · m · g · cos θ)   ◄─ ui-landscape-demo
                                                      ├─► physics-aerodynamics         (½ · ρ · CdA · v · |v|) ◄── physics-environment (ρ)
                                                      └─► physics-gravity-resistance   (m · g · sin θ)
                                              │
                                              ▼ physics.state (step 0, every 25 steps, at finish)
presentation:  HUD: ui-widget-virtual-speed (km/h) · ui-widget-virtual-distance (km) · ui-widget-gradient (%)
```

The boundary between event time and simulation time: the physics **asks** the temporal data layer for the inputs valid at each step time. It never waits for sensor events, nobody feeds it synthetic events, and estimation stays in the temporal data layer. Only `physics-engine` owns a clock-driven loop; every other physics plugin is a pure contributor the engine calls inside a step. The terrain follows the same layering: sensors → drivers → interpolation layer → physics. **Data never reaches the physics by event**: physics plugins read input data only through readers (`ctx.temporal`, `ctx.spatial`) and subscribe to lifecycle events (`activity.*`) only; a unit test over every `plugins/physics-*` enforces it. Decisions: [ADR 0026](../decisions/0026-physics-model-and-fixed-step.md), [ADR 0027](../decisions/0027-road-gradient-and-environment.md), [ADR 0043](../decisions/0043-terrain-preview-by-event.md), [ADR 0044](../decisions/0044-ui-landscape-as-world-sensor-and-spatial-layer.md) (amended 2026-11-04); the spatial layer: [spatial.md](spatial.md).

## Plugins

| Plugin | Provides | Requires | Responsibility |
|---|---|---|---|
| `physics-engine` | – | `physics.motion` | Simulation clock: fixed 10 ms step while a ride runs, catch-up, publishes `physics.state` and `physics.state-batch`. The only physics plugin with a timer. |
| `physics-bicycle` | `physics.bicycle` | – | Mass and tyre rolling-resistance coefficient. |
| `physics-rider` | `physics.rider` | – | Mass and CdA of the rider on the bicycle. |
| `physics-environment` | `physics.environment` | – | Air density. Computes no forces. |
| `physics-rolling-resistance` | `physics.resistance`, `config.snapshot` | `physics.bicycle` | `Crr · f · m · g · cos θ` while moving, 0 at standstill; `f` the surface factor (asphalt 1.0, gravel 2.0). |
| `physics-aerodynamics` | `physics.resistance` | `physics.environment`, `physics.rider` | `½ · ρ · CdA · v_rel · |v_rel|`, still air (`v_rel = v`), ρ from the environment. |
| `physics-gravity-resistance` | `physics.resistance` | – | `m · g · sin θ`, `θ = atan(gradient)`: positive uphill, negative downhill, at every speed. Reads no provider. |
| `physics-total-resistance` | `physics.total-resistance` | `physics.resistance` | Signed sum; contributions sorted by source. |
| `physics-powertrain` | `physics.powertrain` | `metric.power` | Rider power at the step time to wheel power, η = 1.0. |
| `physics-virtual-speed` | `physics.motion` | `physics.bicycle`, `physics.powertrain`, `physics.rider`, `physics.total-resistance`, `spatial.terrain` | Integrator: drive force, acceleration, speed, distance; reads the road from the spatial reader once per step and validates it. Subscribes to nothing, publishes nothing. |
| `ui-widget-virtual-speed` | – | – | HUD widget `widget-virtual-speed`: `speed · 3.6`, one decimal, km/h, order 4. |
| `ui-widget-virtual-distance` | – | – | HUD widget `widget-virtual-distance`: `distance / 1000`, two decimals, km, order 5. |
| `ui-widget-gradient` | – | – | HUD widget `widget-gradient`: `road.gradient · 100`, one decimal, %, order 6; downhill with an ASCII minus ("-5.0"). |

All are `AGPL-3.0-or-later`; the physics plugins import only `@ridrs/contracts` , the widgets only contracts, `@ridrs/ui-sdk` and React. The widgets subscribe to `physics.state`, round with `formatDecimal` from `@ridrs/ui-sdk` and show an en dash before the first state.

## Contracts (`packages/contracts/src/physics.ts`)

SI units everywhere. Resistance forces are signed along the direction of travel: **positive opposes forward motion**. Speed is forward-only.

- `BicycleCapability.parameters()` → `{ mass, rollingResistanceCoefficient }`, `RiderCapability.parameters()` → `{ mass, cdA }`; each a `PhysicsParameter { value, origin: 'default' }`.
- `EnvironmentCapability.parameters()` → `{ airDensity }` (single).
- `RoadSample { gradient, surface, origin }`: the road the forces of a step use. `gradient` is rise over run, dimensionless: 0.05 is 5 % uphill; `surface` is `asphalt` or `gravel` (`physics.state.road.surface`, zod-validated).
- Event `world.terrain-preview` (`packages/contracts/src/world.ts`): `{ revision, originDistance, spacing, samples: [{ gradient, surface? }] }`, at least two samples; sample `i` lies at the odometer reading `originDistance + i · spacing`; no surface means asphalt. An input, read by `spatial-terrain` only. Diagnostics `terrain-preview-missing`, `terrain-preview-rejected`.
- `ResistanceProvider { source; force({ at, speed, mass, road }) }` (multiple). `mass` is the total moving mass and `road` the sample at the rider's position, both computed once by the integrator.
- `TotalResistanceCapability.evaluate(input)` → `{ total, contributions }`.
- `PowertrainCapability.wheelPower(at)` → `{ riderPower: TemporalValue, wheelPower, efficiency }`.
- `MotionCapability.initial(at)` and `advance(previous, at)` → `MotionResult` (state plus acceleration, mass, powers, drive force, the resistance breakdown and the road sample the forces used).
- Event `physics.state`: a `MotionResult` plus `sessionId` and `step` (zod-validated). Diagnostic `physics-step-failed`. `PhysicsStepError` carries the failing plugin. `STANDARD_GRAVITY = 9.81`.

## Defaults

| Parameter | Default | Owner |
|---|---|---|
| Step | 10 ms (100 Hz), `dt = 0.01 s` | `physics-engine` (`ENGINE_DEFAULTS`) |
| Publish `physics.state` | step 0, every 25 steps (250 ms), final state at finish | `physics-engine` |
| Catch-up chunk | 1000 turns, then yield | host clock ([time-and-scheduling.md](time-and-scheduling.md)) |
| Gravity `g` | 9.81 m/s² | contracts |
| Rider mass, CdA | 75 kg, 0.32 m² (hoods) | `physics-rider` (`RIDER_DEFAULTS`) |
| Bicycle mass, Crr | 10 kg, 0.004 (the tyre on asphalt) | `physics-bicycle` (`BICYCLE_DEFAULTS`) |
| Surface factor of Crr | asphalt 1.0, gravel 2.0 (Crr 0.008) | `physics-rolling-resistance` (`ROLLING_DEFAULTS`, in its configuration snapshot) |
| Air density ρ | 1.225 kg/m³ (still air) | `physics-environment` (`ENVIRONMENT_DEFAULTS`); no other plugin keeps a fallback |
| Demo course | segments by start: 0 m: 0 %, 2000 m: +5 %, 3000 m: 0 %, 3500 m: −5 %, 4500 m: 0 % (flat to infinity) | `ui-landscape-demo` (`DEMO_COURSE`) |
| Demo surface | asphalt `[0, 500)`, gravel `[500, 1000)`, repeating every 1 km | `ui-landscape-demo` (`DEMO_SURFACE`) |
| Terrain window | 20 m ahead, a sample every 1 m (21 samples), republished below 10 m left ahead of the presented position | `ui-landscape-demo` (`TERRAIN_WINDOW`) |
| Valid gradient | finite and within ±0.30 | `physics-virtual-speed` (`VIRTUAL_SPEED_DEFAULTS`), and `world-driver-ui` before a window becomes an input |
| Powertrain efficiency η | 1.0 | `physics-powertrain` (`POWERTRAIN_DEFAULTS`) |
| Minimum drive speed `v_min` | 1 m/s | `physics-virtual-speed` (`VIRTUAL_SPEED_DEFAULTS`) |

There is no configuration, persistence or settings UI.

## The step

- **Lifecycle.** On `running`: `t₀ = startedAt`; step 0 = `initial(t₀)` (standstill) runs as a task at `t₀`, after the turn that started the ride; then the timer is armed. Step 0 rides the default road (flat asphalt): the landscape's first window is an input that arrives later. On `finished` (same session): remaining due steps with `t ≤ endedAt`, the final state unless already published, timer released. Idle: no timer, no states. Plugin stop releases the timer.
- **Clock.** Step `n` advances from `tₙ` to `tₙ₊₁ = t₀ + 10·(n+1)`, computed from the index, only when `now ≥ tₙ₊₁`. Each step is a task on `ctx.clock` at its planned time `tₙ₊₁`; it observes that time however late it runs. A late host runs the overdue steps in order, in chunks ([time-and-scheduling.md](time-and-scheduling.md)).
- **Integrator** (semi-implicit Euler, state `n` → `n+1` at `t = tₙ₊₁`):

  ```text
  m       = rider.mass + bicycle.mass
  road    = spatial.terrain.valueAt(xₙ)    (gradient linear, surface stepwise; validated: finite, |gradient| ≤ 0.30)
  P_wheel = powertrain.wheelPower(t).wheelPower
  F_drive = P_wheel / max(vₙ, v_min)
  F_res   = totalResistance.evaluate({ at: t, speed: vₙ, mass: m, road }).total
  a       = (F_drive − F_res) / m
  vₙ₊₁    = max(0, vₙ + a · dt)
  xₙ₊₁    = xₙ + vₙ₊₁ · dt
  reported acceleration = (vₙ₊₁ − vₙ) / dt
  ```

- **Inputs.** State-dependent inputs (speed, mass, road at the current position) come in `ResistanceInput`, computed once per step from the previous state; every force of a step uses the same sample, and the state reports it. Constant model parameters (Crr, CdA, ρ) are fetched by each resistance plugin from its provider. Resistance plugins never query the road themselves.
- **Failures.** A contributor exception, a non-finite value or invalid parameters fail the step: one `physics-step-failed` (plugin, step, session), no further states for this ride. Host, metrics and UI keep running; a new ride tries again.

## The road and motion on slopes

- **Terrain ahead.** The terrain comes in metres along the rider's path, anchored at the physics odometer; the physics keeps the odometer and never asks a world. Per step it reads the spatial series `spatial.terrain` at the previous distance `xₙ`: the gradient interpolated linearly, the surface stepwise ([spatial.md](spatial.md)). Distance, not time: the terrain does not depend on speed.
- **Ride start.** Until the first window of a ride arrives, the road is flat asphalt (`origin: 'default'`). The landscape publishes its first window when it is mounted for the ride, after step 0; that gap is expected and reports nothing. The demo course starts flat on asphalt, so the default is exact there; a course that does not would switch to its real values after a few steps (millimetres).
- **Gaps after that.** Beyond the newest window the reader answers `held` (the last sample), which the physics uses; behind a window's origin it answers `unavailable` and the last road holds. Either way the physics reports `terrain-preview-missing` once per gap (`distance`, `at`, `reason`: `outside-window` or `no-source`, `quality: 'held'` for a held value). An invalid gradient fails the step naming the reader's `sourceId`.
- **Headless is always flat.** Without a UI no window ever arrives: a headless ride is flat on asphalt and reports nothing (intended).
- **Writing a world:** see [world-plugins.md](world-plugins.md).
- **Demo landscape.** Until routes exist, `ui-landscape-demo` owns a fixed landscape by ride distance: 2 km flat, 1 km at 5 %, 500 m flat, 1 km at −5 %, then flat; asphalt and gravel alternating every 500 m. The course is piecewise constant (a segment starts exactly at its `from`); the windows sample it every metre on a fixed grid (from the whole metre at or before the presented position), so the physics sees each boundary as a 1 m ramp: from 1999 to 2000 m the gradient goes from 0 to 5 %. Physics tests replace the landscape with mock worlds that feed the same inputs.
- **Uphill with power:** the speed settles where drive equals resistance, about 14.9 km/h at 200 W on 5 % (34.2 km/h on the flat, 32.2 km/h on flat gravel).
- **Downhill without power:** at standstill gravity is negative and rolling resistance 0, so the rider starts rolling; drag and rolling resistance bound the speed (about 50.3 km/h at −5 %). With 200 W it reaches about 57.9 km/h.
- **Uphill without power:** the net force is negative and the clamp keeps the speed at 0. The rider comes to rest and stays there. Known simplification ("brakes held"): no reverse motion, no rolling back.

## Boundary to the temporal data layer

`physics-powertrain` is the only physics plugin with a temporal reader (`metric.power`). The state at `tₙ₊₁` uses `valueAt(tₙ₊₁)`, step 0 `valueAt(t₀)`. Every available quality drives; every unavailability (`no-source`, `stale`, `disconnected`, `out-of-range`) means `wheelPower = 0`. The `TemporalValue` is carried in the state unchanged, so its quality or reason stays visible. A late step may see a measurement that arrived meanwhile and use an interpolated instead of an extrapolated value; that is intended. In fake time, a step due at the same instant as a delivery runs before it.

## Tests

- Cucumber (`tests/features/physics/`, `@fake-timers`): the simulation clock, time-aligned inputs, resistance forces, virtual speed and the replaceable plugins, through the real host and discovery. Phase 6: gravity, environment and climbing/descending, with mock worlds (`test-road`: constant gradient, "flat for N m, then G %", the demo course on asphalt, or the demo landscape) that feed `world.terrain-preview` as inputs when the ride starts, and the probe `test-environment`. `terrain-preview.feature`: step 0 on the default and step 1 on the first window, linear interpolation, no world (flat, silent), a gap after the first window, a window run out (held, reported), 200 W on flat asphalt and gravel, a window without surface. Phase 10: `spatial/`, `world/` (the driver's validation) and gravel in `resistance-forces.feature`. "The host is blocked" uses `fakeClock.jump`, which fires overdue timers once, late.
- Vitest: force formulas (gravity at ±5 % and 0, `cos θ` in rolling), the integrator step, `v_min`, the clamp, standstill on a climb for 10 000 steps, gradient validation, the course lookup at segment boundaries, the terrain window and its interpolation and gaps, the environment's ρ in aerodynamics, step times over 360 000 steps, catch-up chunks, determinism on the real host, that contributors publish nothing and subscribe to nothing, that every `plugins/physics-*` subscribes to `activity.*` only, that the environment computes no forces and gravity reads no provider, the surface factor.
- e2e (`@ui`, real timers): `ride-with-virtual-speed.feature` with the `simulated-trainer` fixture; `ride-a-climb.feature` adds the `short-climb` fixture (`fixture-landscape-short-climb`: a UI landscape publishing one 2 km window when mounted, flat for 20 m, then 5 %, never bundled) in place of `ui-landscape-demo`.

## What later phases extend

- **Later (plan):** wind with a real wind source (`physics-environment`, `v_rel` in `physics-aerodynamics`), other tyres and more surfaces, drafting, braking and reverse motion, extended powertrain models. Each is one more provider behind the existing capabilities.
- **Phase 7 (done):** the engine also streams every step in `physics.state-batch` (batches of 5 steps); a UI-side presentation interpolates them per frame, 60 ms in the past. `physics.state` stays unchanged for the HUD and headless consumers. See [presentation.md](presentation.md) and ADR 0028. Whether the physics moves to a worker is decided from the Phase 7 manual check.
- **Phase 8:** trainer control from the virtual state (resistance, ERG), e.g. the gradient of `physics.state.road`.
- **Phase 10 (done):** the landscape moved to the UI as the world's sensor, with `world-driver-ui`, `@ridrs/spatial` and `spatial-terrain`; surfaces scale the rolling resistance. Route geometry later is another sensor and driver feeding the same `world.terrain-preview`.

## Phase 8: what the trainer should feel

`physics-trainer-load` provides `physics.trainer-load`: per step, the load of the virtual bike as FTMS simulation parameters (gradient, `Crr · surface factor`, `cw = ρ · CdA`, no wind) without the virtual gear (`resistance`) and with it (`resistanceWithVirtualGear`, an effective gradient, [ADR 0054](../decisions/0054-trainer-load-and-virtual-gear-formula.md)). The engine asks it once per step after the motion, when installed (`optionalRequires`), and puts it into `physics.state` and every `physics.state-batch` sample as `trainerLoad`; speeds and distances are bit-identical with and without it. The surface factors are a contract constant (`SURFACE_ROLLING_FACTORS`) shared with the rolling resistance. The virtual gear comes from the series `drivetrain.virtual-gear` through a reader; the physics never hears `drivetrain.gear-changed`. See [trainer-control.md](trainer-control.md).
