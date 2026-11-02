<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# Physics Engine (Phase 5)

Phase 5 use case: **I pedal 200 W and ridrs shows my virtual speed.** Measured rider power moves a virtual rider of 85 kg on a flat road in still air. The HUD shows speed and distance next to power and cadence.

```text
event-driven:  trainer ─► device-ftms-trainer ─► measurement.power ─► metric-power ─► series metric.power (damped-trend)
                                                                                           │ reader.valueAt(t)
clock-driven:  activity.state-changed ─► physics-engine: running → step n every 10 ms (t = startedAt + 10·n)
                                              │ motion.advance(previous, t)
                                              ▼
                                     physics-virtual-speed  (integrator: acceleration, speed, distance)
                                       │ wheelPower(t)    │ evaluate(t, v, m)          │ parameters()
                                       ▼                  ▼                            ▼
                             physics-powertrain   physics-total-resistance     physics-bicycle · physics-rider
                             (η = 1.0, reads          │ getAll(physics.resistance)
                              metric.power)           ├─► physics-rolling-resistance  (Crr · m · g)
                                                      └─► physics-aerodynamics         (½ · ρ · CdA · v · |v|)
                                              │
                                              ▼ physics.state (step 0, every 25 steps, at finish)
presentation:  HUD: ui-widget-virtual-speed (km/h) · ui-widget-virtual-distance (km)
```

The boundary between event time and simulation time: the physics **asks** the temporal data layer for the inputs valid at each step time. It never waits for sensor events, nobody feeds it synthetic events, and estimation stays in the temporal data layer. Only `physics-engine` owns a clock-driven loop; every other physics plugin is a pure contributor the engine calls inside a step. Decisions: [ADR 0026](../decisions/0026-physics-model-and-fixed-step.md).

## Plugins

| Plugin | Provides | Requires | Responsibility |
|---|---|---|---|
| `physics-engine` | – | `physics.motion` | Simulation clock: fixed 10 ms step while a ride runs, catch-up, publishes `physics.state`. The only physics plugin with a timer or events. |
| `physics-bicycle` | `physics.bicycle` | – | Mass and tyre rolling-resistance coefficient. |
| `physics-rider` | `physics.rider` | – | Mass and CdA of the rider on the bicycle. |
| `physics-rolling-resistance` | `physics.resistance` | `physics.bicycle` | `Crr · m · g` while moving, 0 at standstill. |
| `physics-aerodynamics` | `physics.resistance` | `physics.rider` | `½ · ρ · CdA · v_rel · |v_rel|`, still air (`v_rel = v`). |
| `physics-total-resistance` | `physics.total-resistance` | `physics.resistance` | Signed sum; contributions sorted by source. |
| `physics-powertrain` | `physics.powertrain` | `metric.power` | Rider power at the step time to wheel power, η = 1.0. |
| `physics-virtual-speed` | `physics.motion` | `physics.total-resistance`, `physics.powertrain`, `physics.bicycle`, `physics.rider` | Integrator: drive force, acceleration, speed, distance. |
| `ui-widget-virtual-speed` | – | – | HUD widget `widget-virtual-speed`: `speed · 3.6`, one decimal, km/h, order 4. |
| `ui-widget-virtual-distance` | – | – | HUD widget `widget-virtual-distance`: `distance / 1000`, two decimals, km, order 5. |

All are `AGPL-3.0-or-later`; the physics plugins import only `@ridrs/contracts` (and rxjs in the engine), the widgets only contracts, `@ridrs/ui-sdk` and React. Both widgets subscribe to `physics.state`, round with `formatDecimal` from `@ridrs/ui-sdk` and show an en dash before the first state.

## Contracts (`packages/contracts/src/physics.ts`)

SI units everywhere. Resistance forces are signed along the direction of travel: **positive opposes forward motion**. Speed is forward-only.

- `BicycleCapability.parameters()` → `{ mass, rollingResistanceCoefficient }`, `RiderCapability.parameters()` → `{ mass, cdA }`; each a `PhysicsParameter { value, origin: 'default' }`.
- `ResistanceProvider { source; force({ at, speed, mass }) }` (multiple). `mass` is the total moving mass, computed once by the integrator.
- `TotalResistanceCapability.evaluate(input)` → `{ total, contributions }`.
- `PowertrainCapability.wheelPower(at)` → `{ riderPower: TemporalValue, wheelPower, efficiency }`.
- `MotionCapability.initial(at)` and `advance(previous, at)` → `MotionResult` (state plus acceleration, mass, powers, drive force and the resistance breakdown).
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
| Air density ρ | 1.225 kg/m³ (still air) | `physics-aerodynamics` (`AERODYNAMICS_DEFAULTS`) |
| Powertrain efficiency η | 1.0 | `physics-powertrain` (`POWERTRAIN_DEFAULTS`) |
| Minimum drive speed `v_min` | 1 m/s | `physics-virtual-speed` (`VIRTUAL_SPEED_DEFAULTS`) |

There is no configuration, persistence or settings UI.

## The step

- **Lifecycle.** On `running`: `t₀ = startedAt`, step 0 = `initial(t₀)` (standstill), published at once, timer armed. On `finished` (same session): remaining due steps with `t ≤ endedAt`, the final state unless already published, timer released. Idle: no timer, no states. Plugin stop releases the timer.
- **Clock.** Step `n` advances from `tₙ` to `tₙ₊₁ = t₀ + 10·(n+1)`, computed from the index, only when `now ≥ tₙ₊₁`. One rxjs `timer` is re-armed to the next due time; each wake computes every due step in order (at most 1000), then re-arms with delay 0. A late host computes the same steps later.
- **Integrator** (semi-implicit Euler, state `n` → `n+1` at `t = tₙ₊₁`):

  ```text
  m       = rider.mass + bicycle.mass
  P_wheel = powertrain.wheelPower(t).wheelPower
  F_drive = P_wheel / max(vₙ, v_min)
  F_res   = totalResistance.evaluate({ at: t, speed: vₙ, mass: m }).total
  a       = (F_drive − F_res) / m
  vₙ₊₁    = max(0, vₙ + a · dt)
  xₙ₊₁    = xₙ + vₙ₊₁ · dt
  reported acceleration = (vₙ₊₁ − vₙ) / dt
  ```

- **Failures.** A contributor exception, a non-finite value or invalid parameters fail the step: one `physics-step-failed` (plugin, step, session), no further states for this ride. Host, metrics and UI keep running; a new ride tries again.

## Boundary to the temporal data layer

`physics-powertrain` is the only physics plugin with a temporal reader (`metric.power`). The state at `tₙ₊₁` uses `valueAt(tₙ₊₁)`, step 0 `valueAt(t₀)`. Every available quality drives; every unavailability (`no-source`, `stale`, `disconnected`, `out-of-range`) means `wheelPower = 0`. The `TemporalValue` is carried in the state unchanged, so its quality or reason stays visible. A late step may see a measurement that arrived meanwhile and use an interpolated instead of an extrapolated value; that is intended. In fake time, a step due at the same instant as a delivery runs before it.

## Tests

- Cucumber (`tests/features/physics/`, `@fake-timers`): the simulation clock, time-aligned inputs, resistance forces, virtual speed and the replaceable plugins, through the real host and discovery. "The host is blocked" uses `fakeClock.jump`, which fires overdue timers once, late.
- Vitest: force formulas, the integrator step, `v_min`, the clamp, step times over 360 000 steps, catch-up chunks, determinism on the real host, and that contributors neither subscribe nor publish.
- e2e (`tests/features/apps/ride-with-virtual-speed.feature`, `@ui`, real timers): `startRidrsApp` with the `simulated-trainer` fixture.

## What later phases extend

- **Phase 6:** `physics-environment` (air density, wind), `physics-gravity-resistance`, `physics-road`; `physics-aerodynamics` takes ρ and wind instead of its still-air fallback, rolling resistance gains `cos θ`.
- **Phase 7:** state history and presentation interpolation replace `physics.state` for rendering; physics may move to a worker.
- **Phase 8:** trainer control from the virtual state (resistance, ERG).
