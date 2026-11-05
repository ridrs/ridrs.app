<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# Time and Scheduling

The same recorded external inputs, in the same order, with the same configuration and code, give the same logical execution sequence and the same simulation states: live and on replay. This page defines how ([ADR 0039](../decisions/0039-deterministic-time-and-scheduling.md)).

## The clock

`Clock` (contracts) is the only source of time and scheduling for simulation code:

| Method | Meaning |
|---|---|
| `now()` | The logical time, epoch ms. Constant during a turn. |
| `scheduleAt(t, callback)` | Runs `callback` in its own turn at `t` (at the current time if `t` has passed). |
| `scheduleEvery(interval, callback)` | Runs at `now + interval`, `+ 2·interval`, …: planned from the first run, never from wake-ups. |
| `cancel(taskId)` | Removes a scheduled task. |

Plugins get it as `ctx.clock`; their tasks belong to their context and are cancelled when they stop. Two implementations share one turn queue (`TurnClock` in `packages/core/src/clock.ts`):

- **`LiveClock`**: driven by a monotonic time source (`performance.timeOrigin + performance.now()`, whole ms; injected in tests) and woken by one timer for the next due task (a `TimerPort`, global timers by default).
- **`ReplayClock`**: no time source, no timers; the replay calls `advanceTo(t)`.
- **A held `LiveClock`** (`heldAt`, [ADR 0057](../decisions/0057-continuing-an-interrupted-ride.md)): a continuing host starts like a replay, moved only by `advanceTo(t)`, then `release()` hands it to the time source: logical time jumps from the interruption to now, the tasks due in between run at their planned times first. While held, the plugins' inputs wait in the host and enter after `goLive()`; injected inputs keep their ids and new input ids go on after the highest.

A callback observes its **planned** time, however late it runs. Wall-clock time never enters a simulation calculation.

## Turns

A **turn** is one queue item: a scheduled task, or an accepted external input. It runs synchronously, with everything it publishes (the event bus's run-to-completion cascade), and observes one logical time from start to end: computing never advances logical time. Host start, stop and plugin restarts are lifecycle phases outside the queue, in which plugins may publish too.

**Order.** Items run in ascending `(logical time, kind, sequence number)`, where **tasks come before inputs** at the same logical time:

- a task: its planned time and its scheduling order;
- an input: the time-source reading when it was accepted, and its order of acceptance.

Logical timestamps are never shifted; ties are resolved by this order alone. When an input arrives at `t`, every task due at or before `t` runs first, whether its wake-up came already or not. A task cannot be "running" when an input arrives: turns are synchronous. Work a turn schedules for its own time or earlier runs at the current time, after the turn, before any further input of that time. A step at `t` therefore knows exactly the inputs accepted before `t`: a measurement arriving at `t` takes effect from the next step on, independent of when callbacks really ran.

**Catch-up.** A late wake runs every overdue task at its planned time, in order, in chunks of 1000 turns, yielding to the event loop between chunks; an input arriving meanwhile waits for the tasks due before it. No step is skipped, the frequency never changes.

## External inputs

External inputs are BLE notifications and connection results, rider input from the UI, and every result of asynchronous work. They enter through the **central input queue**:

- `ctx.inputs.accept(event, payload)` validates at once (throwing like `publish`) and queues the event; it is published in its own turn as an envelope with `input: true` and `receivedAt`.
- `PluginHost.publishEvent(source, …)` does the same for composition roots (the UI bridge).
- Plugins of the input side (manifest types `transport`, `storage`, `recording`, `export`, `ui`) may publish outside a turn: it is accepted as an input.
- Any other publish, and any temporal write, outside a turn throws `outside-turn`: a promise continuation cannot change simulation state behind the queue.

Late and out-of-order sensor measurements are not reordered: inputs keep their acceptance order and their measurement times; the temporal layer rejects a late measurement as before ([ADR 0024](../decisions/0024-late-measurements-rejected.md)).

The BLE link (`@ridrs/ble-peripheral`) is the input side of a device plugin: notifications and connection states go through `ctx.inputs`; the device plugin decodes in the turn of its own `device.raw-notification`.

## Envelopes and ids

Every envelope has a global `seq` (publish order, from 1). Ids derive from the host run's `runId` (random once per host, recorded, reused on replay), without randomness of their own and without a library:

- inputs: `<runId>:in:<input number>`, kept on replay;
- derived events: `<runId>:<source>:<logical time>:<k>`, `k` counting that source's envelopes in that millisecond;
- `ctx.ids.next()` (e.g. session ids): `<runId>:<plugin>:<logical time>:<k>`.

They are unique within a run and reproduce on replay whenever the stream itself does.

## Enforcement

- Runtime: `outside-turn` for publishes and temporal writes of simulation plugins outside turns.
- Lint: biome `noRestrictedGlobals` forbids `Date`, `performance`, `setTimeout`, `setInterval`, `setImmediate`, `queueMicrotask` and `requestAnimationFrame` in simulation plugins, `@ridrs/metric-source` and `@ridrs/temporal`. Exempt: transport, bridge connector, storage, recording, export and UI plugins, and tests.
- The presentation (`@ridrs/presentation`, the shell's frame clock) keeps its own clock: rendering reads, never drives.

## Tests

- `packages/core/src/clock.test.ts`: computing does not advance logical time; late and periodic tasks keep their planned times; tasks before inputs at the same time whether the wake came first or not; inputs with equal times keep arrival order and are never moved; catch-up in chunks with an input arriving meanwhile; `outside-turn` and acceptance as an input; one timestamp per cascade, `seq` and ids; plugin tasks cancelled on stop.
- `tests/unit/live-replay-determinism.test.ts`: a live ride with wake-ups 0–6 ms late, turns that take time, BLE notifications delivered asynchronously at jittered times and late/out-of-order heart-rate measurements replays **identically** (three seeds, ids included), twice deep-equal. A mutation in which tasks observe their wake time instead fails it.
- `tests/features/apps/ride-save-and-replay.feature`: the real app on **real timers**, its recording replayed with the CLI: identical.
