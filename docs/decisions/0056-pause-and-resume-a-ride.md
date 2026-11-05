<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0056: Pause and Resume a Ride

Status: accepted on 2026-11-05 and implemented the same day, for [ADR 0052](0052-persistence-domains-and-plan.md) (phase P4). The prerequisite of [ADR 0057](0057-continuing-an-interrupted-ride.md).

## Context

The activity knows `idle → running → finished`, and `physics-engine` plans step n at `startedAt + 10·n`. A rider who stops for a drink keeps the ride's clock running. After a crash, the restarted clock would run every step of the downtime as riding (catch-up). Both need the same thing: a ride that stands still while logical time goes on.

## Decision

- **Activity state `paused`** `{ sessionId, startedAt, pausedAt, reason: 'rider' | 'interrupted' }`. `running` gains an optional `resumedAt`: absent at the start, the resume time after a pause.
- **Requests**: `activity.pause-requested` and `activity.resume-requested` (the rider, the UI) and **`activity.interrupted`**, the input a recovery injects at the interruption ([ADR 0057](0057-continuing-an-interrupted-ride.md)). Pausing a paused or idle ride, resuming a running one, is an `invalid-transition`. A paused ride can finish.
- **Physics**: on `paused` the engine cancels its step task and keeps the ride's simulation; on `running` of the same session it plans the next step at `resumedAt + 10`, then every 10 ms from there. The integrator state stands still in the pause: same speed and distance on resume, no time passes for it (`MotionResult.at` moves to `resumedAt`). Step numbers continue. Finishing while paused computes no more steps.
- **Times**: logical time includes pauses; the **active time** is the sum of the running intervals. `recording.completed.durationMs` stays the whole ride; the FIT export writes `timer stop` at every pause and `timer start` at every resume, and `total_timer_time` is the active time.
- **UI**: the activity screen shows "Paused" in place of the HUD's live values' meaning, a **Pause** button while running and a **Resume** button while paused, next to **Finish ride**, reachable with arrows and Enter; the keep-awake follows `running` only. Back on the activity screen does not pause.

## Consequences

- `activity.state-changed` has a new state; recordings from before parse unchanged. A replay of a paused ride is identical: requests and interruptions are inputs.
- The temporal layer is untouched: series go stale in a pause by themselves.
