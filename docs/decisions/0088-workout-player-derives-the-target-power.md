<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0088: The Workout Player Derives the Target Power

Status: accepted on 2026-11-12 ([structured-workouts.md](../ideas/structured-workouts.md), section 11a).

## Context

The plan said the player sets `trainer.target-power` "as input, as `control-erg` does". An input enters through `ctx.inputs` and is recorded as such; a replay host drops a plugin's inputs and injects the recorded ones, and a continuing host holds a plugin's inputs while it rebuilds the ride and lets them in once it goes live (ADR 0055, 0057). The player's targets are not the rider's input: they follow from the ride's workout (part of `activity.start-requested`, recorded) and the ride's clock.

## Decision

- `plugins/workout-player` publishes `trainer.target-power` as a **derived event**, computed at every whole second of ridden time from the workout of the activity state; `workout.step-changed` and `workout.finished` likewise.
- The rider's own inputs stay inputs: `workout.next-step-requested` ("Next step") and `trainer.erg-requested`.
- `control-erg` keeps publishing its target as an input; during a step with a power target of the workout it ignores the rider's ERG changes (plus and minus), so only the player sets the target.

## Consequences

- A replay recomputes the player's targets and compares them with the recording; a continued ride recomputes them from the same step, instead of replaying stale ramp values at the live time.
- `trainer.target-power` is published both as an input (by `control-erg`) and as a derived event (by the player); the recording keeps the `input` mark per envelope, so each is handled correctly.
