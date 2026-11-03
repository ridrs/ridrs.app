<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0039: Deterministic Time and Scheduling

Supersedes [ADR 0032](0032-replay-virtual-clock.md). Amends ADR 0026 (wake timing).

## Context

Phase 9 recordings of the system clock did not replay exactly: time passed during a run-to-completion cascade, timers fired late and observed their wake time (a late physics step could see a later measurement), and the order of I/O callbacks and timers in the same millisecond was decided by the event loop. A replay on fake timers reproduced scheduled time, not that.

## Decision

- **Logical time.** `Clock` gets `scheduleAt`, `scheduleEvery` and `cancel`; `TimeSource` is a plain monotonic reading. `LiveClock` (monotonic OS clock, one wake-up timer) and `ReplayClock` (driven by the replay) share one turn queue in the core. Time is constant during a turn; a task observes its planned time.
- **Order** `(logical time, tasks before inputs, sequence number)`: no timestamp is ever shifted. Tasks-first keeps every earlier scenario unchanged (test devices already delivered after the tasks due) and means: a step at `t` knows the inputs accepted before `t`.
- **Central input queue** (`ctx.inputs.accept`, `PluginHost.publishEvent`); input-side plugins' publications outside turns are inputs; anything else outside a turn throws `outside-turn`. The BLE link is input side; device plugins decode in the raw input's turn.
- **Ids** from `runId` and counters, no UUID library: the ids are internal (no interoperability requirement), so derivation from the run id and logical time gives uniqueness and reproducibility without a dependency.
- **Replay** uses the same host and queue on a `ReplayClock`: it injects the recorded inputs (`input: true`) with their times and ids, drops its own plugins' I/O (an inert `ble.central` stands in for the transports) and compares ids too. The replay BLE central, the session-id mapping and `@sinonjs/fake-timers` at runtime are gone.
- **Migrated:** the temporal freshness deadlines and `physics-engine` (both rxjs `timer` before), `activity-session` session ids, the BLE link. Input-side plugins keep their wall timers (reconnect backoff, bridge heartbeat): only their results enter, through the queue.

## Consequences

- Recordings now carry `runId` and, per envelope, `seq`, `input` and `receivedAt` (additive, format v1). Recordings made before this change replay with differing session ids.
- Catch-up runs in chunks of 1000 turns (steps and other due tasks) instead of 1000 engine steps.
- Physics envelope timestamps are step times now, live too.
- A real-timer e2e replays identically; the wall-paced test clock is gone.
