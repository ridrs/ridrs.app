<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0113: The Workout Halts While the Rider Cannot Hold Its Target

Status: proposed on 2026-11-26, on the maintainer's request that a rider who stops pedalling in ERG get back into the workout. Concept and simulations: `plans/erg-wiederaufnahme.md`, section 0, and `experiments/erg-recovery/` (outside the repository).

## Context

In ERG the trainer holds the power, so the torque at the crank is power over cadence: as the cadence falls, the load grows. Who stops pedalling at 350 W, to drink or because the interval was too hard, has to push 80–170 Nm at 20–40 rpm to get going again. A tired rider cannot: in the simulation they stay at about 37 rpm and 270 W for good. The cadence below which a rider no longer gets back up is about 54 rpm for a tired rider at 350 W and 79 rpm for an exhausted one; at 50–100 W it is 3–15 rpm.

The trainer's reports (KICKR CORE, recording of 2026-11-15) are what the app has: 1 Hz; the power falls to 0 within a second of the last pedal stroke; the cadence stays at its old value for 2–3 s and then drops to 0; single reports of no cadence occur while pedalling on.

The maintainer decided against lowering the target and ramping it up while the workout's clock runs on: the step would be shortened, and the momentum of the ride lost.

## Decision

- **Only the workout halts; the ride goes on.** While halted, the workout player sets no target: the trainer rides on the gradient of the route and the gears, as in a step without a power target, so the rider rolls on downhill. The step's time and distance stand.
- **When it halts**, in every step with a power target and only with both power and cadence: no power (below 25 W) in two reports in a row; or a spiral, below 45 rpm for 3 s while the power is below 85 % of the target or the cadence falls by 3 rpm/s or more.
- **How it runs again:** pedalling at 30 rpm or more for 2 s starts a countdown of 5 s, during which the target rises from the power pedalled to the step's. It counts only at 55 rpm or more; between 30 and 55 rpm it waits and the load does not change. After its first 2 s it ends below 30 rpm, or with no power once it raised the load. For 3 s after halting, the cadence is not trusted (the trainer still reports the old one).
- **A ceiling against a cycle:** a spiral within 60 s of a countdown lowers the step's target by 5 %, down to 80 %, until the next step.
- **The rider's pause stays apart.** Pausing stops the ride as before, halted or not. Back from a pause, with power and cadence, the workout waits for the first pedal strokes as after a stop. Leaving ERG while halted lets the workout run on at the rider's own load.
- **Where:** in the workout player (`plugins/workout-player/halt.ts`, pure), which owns the workout's clock and already reads power and cadence. It looks every 250 ms of the ride's clock and publishes `workout.halt-changed` (`running`, `halted`, `countdown` with `secondsLeft` and `waiting`, and the ceiling) as a **derived** event, like the targets (ADR 0088): a replay computes it again and compares it. `device-ftms-trainer` is unchanged.
- **The HUD reads it:** the workout widget and the gauge HUD let the step's time stand; the middle of the screen says "Workout halted · pedal to go on", "Pedal faster · from 55 rpm" or "Going on in 3"; the target power widget keeps its place and says "Halted" or "Going on in 3"; the ERG button stays on.

## Consequences

- The load never follows the cadence back and forth: every decision waits longer than the chain report → app → trainer → rider (about 2–3 s), and the bands do not overlap (start at 30 rpm, count at 55 rpm). A countdown that counted on time alone looped in the simulation for a rider at 35 rpm (10 aborts a minute) and resumed a tired rider at 40 rpm into the spiral.
- Simulated over 4 riders × 3 targets × 3 flywheels × 4 brakes × 2 latency chains: back on the target in 264 of 264 cases the rider can hold, also when they pedal on slowly; without the halt 114 of 264.
- From the first pedal stroke to the running workout takes about 10 s, 5 s of them the countdown: 1 Hz reports and the start check allow no less than about 3 s before it.
- A ride without a cadence never halts; a free ERG of the rider's own (`control-erg`, no workout) does not either: there is no workout clock to hold.
- Open, to measure on the KICKR CORE: how fast it switches between ERG and simulation, whether it ramps lowered ERG targets itself, its brake at a very low speed.
