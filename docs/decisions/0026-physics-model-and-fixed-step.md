<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0026: Physics Model and Fixed Step

## Context

Phase 5 turns measured rider power into a virtual speed: "I pedal 200 W and ridrs shows my virtual speed." The physics must be deterministic, replaceable plugin by plugin, and must not depend on how often sensors deliver or when the host gets to run it. Sensors are event-driven; a simulation needs a clock. The temporal data layer (ADR 0023) already answers "what was the power at time t".

## Decision

- **Own domain code, no library.** The model is one-dimensional; force formulas, the integrator and the step clock are a few lines each. No physics engine, ODE solver, units or vector-math package. The step timer is the existing rxjs `timer`, re-armed like the temporal service's deadlines.
- **Units and sign.** SI units in every contract and plugin (kg, m, s, m/s, m/s², N, W, m², kg/m³); km/h and km exist only in the two HUD widgets. Times stay epoch ms from the injected clock. Resistance forces are signed along the direction of travel: positive opposes motion. `STANDARD_GRAVITY = 9.81` lives in the contracts.
- **One plugin per model, behind a capability.** Parameters (`physics.bicycle`, `physics.rider`), resistances (`physics.resistance`, multiple), their sum (`physics.total-resistance`), power at the wheel (`physics.powertrain`) and the integrator (`physics.motion`). The total knows no concrete resistance; the engine knows only `physics.motion`. Every default parameter carries `origin: 'default'`.
- **Fixed step, 100 Hz.** State `n` is at `t₀ + 10·n` with `t₀ = startedAt`, computed from the index, never by repeated addition. A step runs only when `now ≥ tₙ₊₁`, so a state is never ahead of the clock. One timer is re-armed to the next due step; a wake computes every due step in order, at most 1000, then re-arms with delay 0 to continue. Step times and order never depend on wake timing.
- **Inputs are asked, never pushed.** For a state at `t`, `physics-powertrain` asks its `metric.power` reader `valueAt(t)`. Any available quality drives (`wheelPower = η · value`, η = 1.0); any unavailability means no drive and the rider coasts. The physics never estimates, holds or invents power and never writes a series; the `TemporalValue` goes into the state unchanged. The power series keeps `damped-trend` and its defaults: 2 s of held power before coasting is acceptable and rides through short BLE gaps.
- **Input values may depend on wake timing.** A step computed late can already see a measurement that arrived meanwhile and gets an `interpolated` instead of an `extrapolated` power. That is the better estimate and intended. Phase 9 records the inputs actually used.
- **Semi-implicit Euler.** Forces from the previous speed, power at the new state's time: `F_drive = P / max(vₙ, v_min)` with `v_min = 1 m/s`, `a = (F_drive − F_res) / m`, `vₙ₊₁ = max(0, vₙ + a·dt)`, `xₙ₊₁ = xₙ + vₙ₊₁·dt`. `v_min` bounds the start force (200 W → 200 N) and avoids division by zero. The clamp keeps a coasting rider at rest without creeping distance; the reported acceleration is the effective one, after the clamp. Rolling resistance is 0 at standstill so a bicycle at rest stays there.
- **Aerodynamics pulled forward from Phase 6** (maintainer decision 2026-11-02). With rolling resistance only, 200 W climbs for minutes towards ≈ 216 km/h. With drag in still air (ρ = 1.225 kg/m³, CdA 0.32 m², one plugin for rider and bicycle) it settles near 34.2 km/h.
- **Interim `physics.state`.** The engine publishes step 0, every 25th step (≈ 4 Hz of simulation time) and the final state at finish. Phase 7 replaces this for rendering with a state history and presentation interpolation.
- **Failures stop the ride, not the host.** An exception from a contributor, a non-finite value or invalid parameters (non-finite, mass ≤ 0, CdA ≤ 0, Crr < 0) fail the step: one `physics-step-failed` diagnostic (plugin when known, via `PhysicsStepError`; step; session), no further states, timer released. Step 0 evaluates the contributors too. A new ride tries again.

## Code review checklist

dependency-cruiser cannot see calls on `ctx`. For every change to a physics plugin, check:

- Only `physics-engine` calls `ctx.events.subscribe` (`activity.state-changed`) or `ctx.events.publish` (`physics.state`), and only it owns a timer. (Unit test: contributors neither subscribe nor publish in `initialize`/`start`.)
- Only `physics-powertrain` calls `ctx.temporal.reader`; no physics plugin calls `ctx.temporal.writer`.
- Resistance providers report `source = ctx.manifest.id` and never add masses themselves.
- Resistance providers take speed, mass and road from `ResistanceInput` and never query `physics.road` themselves (ADR 0027). `physics-road` and `physics-environment` compute no forces; `physics-gravity-resistance` reads no provider. (Unit test.)

The import rules (contracts only, rxjs only in the engine, no plugin imports) are enforced by dependency-cruiser.

## Consequences

- At 200 W the default rider (75 kg, bicycle 10 kg) reaches ≈ 22 km/h after 10 s and 33.9 km/h after a minute; the scenarios check these numbers with step-by-step Euler, not a closed form.
- A blocked host computes the same steps later; only input qualities may differ.
- `physics.state` at 4 Hz makes the speed display step visibly; acceptable until Phase 7.
- Phase 6 extends `physics-aerodynamics` (air density, wind from `physics-environment`) and adds gravity and road; the sign convention and the `v_rel · |v_rel|` formula already allow negative contributions.
