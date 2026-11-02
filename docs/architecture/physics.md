<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# Physics Engine (Phases 5 and 6)

Phase 5 use case: **I pedal 200 W and ridrs shows my virtual speed.** Measured rider power moves a virtual rider of 85 kg in still air. The HUD shows speed and distance next to power and cadence.

Phase 6 use case: **The same power gives a different speed on a climb than on the flat.** The rider rides a built-in demo course; gravity opposes them uphill and pushes them downhill. The HUD shows the gradient. The physics grew only by adding plugins behind the existing capabilities: `physics-engine` and `physics-total-resistance` are unchanged.

```text
event-driven:  trainer ─► device-ftms-trainer ─► measurement.power ─► metric-power ─► series metric.power (damped-trend)
                                                                                           │ reader.valueAt(t)
clock-driven:  activity.state-changed ─► physics-engine: running → step n every 10 ms (t = startedAt + 10·n)
                                              │ motion.advance(previous, t)
                                              ▼
                                     physics-virtual-speed  (integrator: acceleration, speed, distance)
                                       │ wheelPower(t)    │ evaluate(t, v, m, road)    │ parameters()       │ at(xₙ)
                                       ▼                  ▼                            ▼                    ▼
                             physics-powertrain   physics-total-resistance     physics-bicycle ·    physics-road
                             (η = 1.0, reads          │ getAll(physics.resistance)   physics-rider    (demo course)
                              metric.power)           ├─► physics-rolling-resistance  (Crr · m · g · cos θ)
                                                      ├─► physics-aerodynamics         (½ · ρ · CdA · v · |v|) ◄── physics-environment (ρ)
                                                      └─► physics-gravity-resistance   (m · g · sin θ)
                                              │
                                              ▼ physics.state (step 0, every 25 steps, at finish)
presentation:  HUD: ui-widget-virtual-speed (km/h) · ui-widget-virtual-distance (km) · ui-widget-gradient (%)
```

The boundary between event time and simulation time: the physics **asks** the temporal data layer for the inputs valid at each step time. It never waits for sensor events, nobody feeds it synthetic events, and estimation stays in the temporal data layer. Only `physics-engine` owns a clock-driven loop; every other physics plugin is a pure contributor the engine calls inside a step. Decisions: [ADR 0026](../decisions/0026-physics-model-and-fixed-step.md), [ADR 0027](../decisions/0027-road-gradient-and-environment.md).

## Plugins

| Plugin | Provides | Requires | Responsibility |
|---|---|---|---|
| `physics-engine` | – | `physics.motion` | Simulation clock: fixed 10 ms step while a ride runs, catch-up, publishes `physics.state`. The only physics plugin with a timer or events. |
| `physics-bicycle` | `physics.bicycle` | – | Mass and tyre rolling-resistance coefficient. |
| `physics-rider` | `physics.rider` | – | Mass and CdA of the rider on the bicycle. |
| `physics-environment` | `physics.environment` | – | Air density. Computes no forces. |
| `physics-road` | `physics.road` | – | The road sample (gradient) at a distance, from the built-in demo course. Computes no forces. |
| `physics-rolling-resistance` | `physics.resistance` | `physics.bicycle` | `Crr · m · g · cos θ` while moving, 0 at standstill. |
| `physics-aerodynamics` | `physics.resistance` | `physics.environment`, `physics.rider` | `½ · ρ · CdA · v_rel · |v_rel|`, still air (`v_rel = v`), ρ from the environment. |
| `physics-gravity-resistance` | `physics.resistance` | – | `m · g · sin θ`, `θ = atan(gradient)`: positive uphill, negative downhill, at every speed. Reads no provider. |
| `physics-total-resistance` | `physics.total-resistance` | `physics.resistance` | Signed sum; contributions sorted by source. |
| `physics-powertrain` | `physics.powertrain` | `metric.power` | Rider power at the step time to wheel power, η = 1.0. |
| `physics-virtual-speed` | `physics.motion` | `physics.bicycle`, `physics.powertrain`, `physics.rider`, `physics.road`, `physics.total-resistance` | Integrator: drive force, acceleration, speed, distance; looks up the road once per step and validates it. |
| `ui-widget-virtual-speed` | – | – | HUD widget `widget-virtual-speed`: `speed · 3.6`, one decimal, km/h, order 4. |
| `ui-widget-virtual-distance` | – | – | HUD widget `widget-virtual-distance`: `distance / 1000`, two decimals, km, order 5. |
| `ui-widget-gradient` | – | – | HUD widget `widget-gradient`: `road.gradient · 100`, one decimal, %, order 6; downhill with an ASCII minus ("-5.0"). |

All are `AGPL-3.0-or-later`; the physics plugins import only `@ridrs/contracts` (and rxjs in the engine), the widgets only contracts, `@ridrs/ui-sdk` and React. The widgets subscribe to `physics.state`, round with `formatDecimal` from `@ridrs/ui-sdk` and show an en dash before the first state.

## Contracts (`packages/contracts/src/physics.ts`)

SI units everywhere. Resistance forces are signed along the direction of travel: **positive opposes forward motion**. Speed is forward-only.

- `BicycleCapability.parameters()` → `{ mass, rollingResistanceCoefficient }`, `RiderCapability.parameters()` → `{ mass, cdA }`; each a `PhysicsParameter { value, origin: 'default' }`.
- `EnvironmentCapability.parameters()` → `{ airDensity }` (single).
- `RoadCapability { source; at(distance) }` → `RoadSample { gradient, origin }` (single). `gradient` is rise over run, dimensionless: 0.05 is 5 % uphill.
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
| Steps per wake | at most 1000 | `physics-engine` |
| Gravity `g` | 9.81 m/s² | contracts |
| Rider mass, CdA | 75 kg, 0.32 m² (hoods) | `physics-rider` (`RIDER_DEFAULTS`) |
| Bicycle mass, Crr | 10 kg, 0.004 | `physics-bicycle` (`BICYCLE_DEFAULTS`) |
| Air density ρ | 1.225 kg/m³ (still air) | `physics-environment` (`ENVIRONMENT_DEFAULTS`); no other plugin keeps a fallback |
| Demo course | segments by start: 0 m: 0 %, 2000 m: +5 %, 3000 m: 0 %, 3500 m: −5 %, 4500 m: 0 % (flat to infinity) | `physics-road` (`DEMO_COURSE`) |
| Valid gradient | finite and within ±0.30 | `physics-virtual-speed` (`VIRTUAL_SPEED_DEFAULTS`) |
| Powertrain efficiency η | 1.0 | `physics-powertrain` (`POWERTRAIN_DEFAULTS`) |
| Minimum drive speed `v_min` | 1 m/s | `physics-virtual-speed` (`VIRTUAL_SPEED_DEFAULTS`) |

There is no configuration, persistence or settings UI.

## The step

- **Lifecycle.** On `running`: `t₀ = startedAt`, step 0 = `initial(t₀)` (standstill), published at once, timer armed. On `finished` (same session): remaining due steps with `t ≤ endedAt`, the final state unless already published, timer released. Idle: no timer, no states. Plugin stop releases the timer.
- **Clock.** Step `n` advances from `tₙ` to `tₙ₊₁ = t₀ + 10·(n+1)`, computed from the index, only when `now ≥ tₙ₊₁`. One rxjs `timer` is re-armed to the next due time; each wake computes every due step in order (at most 1000), then re-arms with delay 0. A late host computes the same steps later.
- **Integrator** (semi-implicit Euler, state `n` → `n+1` at `t = tₙ₊₁`):

  ```text
  m       = rider.mass + bicycle.mass
  road    = road.at(xₙ)                    (validated: finite, |gradient| ≤ 0.30)
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

- **Demo course.** Until routes exist, `physics-road` provides a fixed course by ride distance: 2 km flat, 1 km at 5 %, 500 m flat, 1 km at −5 %, then flat. `at(d)` returns the gradient of the last segment with `from ≤ d`; at 2000 m the gradient is already 5 %. Gradients are piecewise constant (continuous elevation, no smoothing). Every ride starts at 0 m. Tests and fixtures replace the course through `physics.road`.
- **Uphill with power:** the speed settles where drive equals resistance, about 14.9 km/h at 200 W on 5 % (34.2 km/h on the flat).
- **Downhill without power:** at standstill gravity is negative and rolling resistance 0, so the rider starts rolling; drag and rolling resistance bound the speed (about 50.3 km/h at −5 %). With 200 W it reaches about 57.9 km/h.
- **Uphill without power:** the net force is negative and the clamp keeps the speed at 0. The rider comes to rest and stays there. Known simplification ("brakes held"): no reverse motion, no rolling back.

## Boundary to the temporal data layer

`physics-powertrain` is the only physics plugin with a temporal reader (`metric.power`). The state at `tₙ₊₁` uses `valueAt(tₙ₊₁)`, step 0 `valueAt(t₀)`. Every available quality drives; every unavailability (`no-source`, `stale`, `disconnected`, `out-of-range`) means `wheelPower = 0`. The `TemporalValue` is carried in the state unchanged, so its quality or reason stays visible. A late step may see a measurement that arrived meanwhile and use an interpolated instead of an extrapolated value; that is intended. In fake time, a step due at the same instant as a delivery runs before it.

## Tests

- Cucumber (`tests/features/physics/`, `@fake-timers`): the simulation clock, time-aligned inputs, resistance forces, virtual speed and the replaceable plugins, through the real host and discovery. Phase 6: gravity, environment, road and climbing/descending, with the probes `test-road` (constant gradient or "flat for N m, then G %") and `test-environment`. "The host is blocked" uses `fakeClock.jump`, which fires overdue timers once, late.
- Vitest: force formulas (gravity at ±5 % and 0, `cos θ` in rolling), the integrator step, `v_min`, the clamp, standstill on a climb for 10 000 steps, gradient validation, the course lookup at segment boundaries, the environment's ρ in aerodynamics, step times over 360 000 steps, catch-up chunks, determinism on the real host, that contributors neither subscribe nor publish, and that road and environment compute no forces and gravity reads no provider.
- e2e (`@ui`, real timers): `ride-with-virtual-speed.feature` with the `simulated-trainer` fixture; `ride-a-climb.feature` adds the `short-climb` fixture (`fixture-road-short-climb`: flat for 20 m, then 5 %, never bundled) in place of `physics-road`.

## What later phases extend

- **Later (plan):** wind with a real wind source (`physics-environment`, `v_rel` in `physics-aerodynamics`), other tyres and surfaces, drafting, braking and reverse motion, extended powertrain models. Each is one more provider behind the existing capabilities.
- **Phase 7 (done):** the engine also streams every step in `physics.state-batch` (batches of 5 steps); a UI-side presentation interpolates them per frame, 60 ms in the past. `physics.state` stays unchanged for the HUD and headless consumers. See [presentation.md](presentation.md) and ADR 0028. Whether the physics moves to a worker is decided from the Phase 7 manual check.
- **Phase 8:** trainer control from the virtual state (resistance, ERG), e.g. the gradient of `physics.state.road`.
- **Phase 10:** route geometry replaces the demo course behind `physics.road`.
