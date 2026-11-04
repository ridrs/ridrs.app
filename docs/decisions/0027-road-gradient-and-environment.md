<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0027: Road Gradient and Environment

**Amended by [ADR 0043](0043-terrain-preview-by-event.md):** the road reaches the physics as the event `world.terrain-preview` from the world `physics-road`; the capability `physics.road` is removed. The demo course is unchanged. **Amended again by [ADR 0044](0044-ui-landscape-as-world-sensor-and-spatial-layer.md):** the demo course now lives in the UI landscape `ui-landscape-demo` (with a surface), `physics-road` is gone, and the physics reads the road from the spatial layer.

## Context

Phase 6 use case: "The same power gives a different speed on a climb than on the flat." The Phase 5 rider rides a flat road in still air with an air-density fallback inside `physics-aerodynamics` (ADR 0026). A gradient needs a road under the rider, a gravity force and the normal force in rolling resistance. There are no routes yet (Phase 10), no trainer control (Phase 8) and no configuration. The physics must grow by adding plugins behind the existing capabilities: the engine and the total-resistance aggregator do not change.

## Decision

- **Own domain code, no library.** `Math.atan`, `Math.sin` and `Math.cos` are enough. No units, geometry or route library; Phase 10 decides about route geometry.
- **Gradient as a ratio.** A `RoadSample` carries `gradient` as rise over run, dimensionless (0.05 = 5 % uphill, −0.05 = 5 % downhill), plus `origin: 'default'`. Forces use the angle `θ = atan(gradient)`: gravity `m · g · sin θ` (positive uphill, negative downhill, at every speed), rolling resistance `Crr · m · g · cos θ` while moving. Percent exists only in the HUD widget and the scenario texts.
- **Two new capabilities, both `single`.** `physics.road` (`at(distance)` → `RoadSample`, plus the provider's `source` so that an invalid sample can name it) and `physics.environment` (`parameters()` → `{ airDensity }`). `physics-gravity-resistance` is one more `physics.resistance` provider and reads no provider.
- **Built-in demo course.** `physics-road` provides a fixed course by ride distance: segments `{ from, gradient }` at 0 m: 0 %, 2000 m: +5 %, 3000 m: 0 %, 3500 m: −5 %, 4500 m: 0 % to infinity. `at(d)` returns the gradient of the last segment with `from ≤ d`; a segment starts exactly at its `from`. Gradients are piecewise constant, so the elevation is continuous; there is no smoothing at the boundaries. Every ride starts at the beginning of the course. No course selection, no loading, no manual gradient control (maintainer decision 2026-11-02). Tests and fixtures replace the course through the `physics.road` capability. Phase 10 replaces it with route geometry behind the same capability.
- **Road lookup at the previous distance.** `physics-virtual-speed` calls `road.at(previous.distance)` once per step (`road.at(0)` in `initial`) and passes the sample in `ResistanceInput.road`, like mass. Forces use the previous state, as in Phase 5; a step never consumes its own output. The state reports the sample its forces used (`MotionResult.road`, `physics.state.road`), so gradient and force breakdown always belong together. A sample that is not finite or outside ±0.30 fails the step with `physics-step-failed`, naming the road provider.
- **Input rule.** State-dependent inputs (speed, mass, road at the current position) come in `ResistanceInput`, computed once by the integrator. Constant model parameters (Crr, CdA, ρ) are fetched by each resistance plugin from its provider. Resistance plugins never query the road themselves.
- **Air density only.** `physics-environment` owns ρ = 1.225 kg/m³ (`origin: 'default'`). `physics-aerodynamics` requires `physics.environment` and keeps no fallback; ρ that is not finite or ≤ 0 fails the step naming `physics-aerodynamics`. Wind stays "later" and arrives with a real wind source; the drag formula `½ · ρ · CdA · v_rel · |v_rel|` already allows it.
- **Forward-only motion on climbs ("brakes held").** The integrator is unchanged. Without power on a climb, gravity makes the net force negative and the clamp keeps the speed at 0: the rider comes to rest and stays there. There is no reverse motion and no rolling back. Downhill, gravity is negative and rolling resistance 0 at standstill, so a rider at rest starts rolling; drag and rolling resistance bound the speed (about 50.3 km/h at −5 %).

## Consequences

- At a steady 200 W the default rider settles near 34.2 km/h on the flat, 14.9 km/h on 5 % and 57.9 km/h on −5 %. The scenarios check the step-by-step Euler values.
- On a flat road gravity is 0 and `cos θ` is 1, so every Phase 5 number is unchanged. The demo course is flat for the first 2000 m, more than the longest Phase 5 scenario rides.
- The speed and gradient jump at a segment boundary within one step; the HUD shows it at 4 Hz. Phase 7 (presentation) and Phase 10 (route geometry) may smooth it.
- The road sample of a state is the one at the previous distance, at most one step (≈ 0.17 m at 60 km/h) behind the position reported in the same state.
- Phase 8 can send the gradient of `physics.state.road` to the trainer.
