<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0032: Replay on a Virtual Clock (`@sinonjs/fake-timers` at Runtime)

**Superseded by [ADR 0039](0039-deterministic-time-and-scheduling.md):** the replay runs on the host's own `ReplayClock`; fake timers are test-only again.

Extends ADR 0011.

## Context

A replay must run a recorded ride through the current plugins as fast as possible, with every timer firing at the recorded times.

## Decision

- `@ridrs/replay` (headless, Node-only) depends on **@sinonjs/fake-timers** 15.4.0 at runtime. It installs it at the first recorded record's time with the same faked set as ADR 0011 and advances with `tickAsync` to the recorded end.
- Recorded actions (raw notifications, reachability changes, input events) are scheduled as timers in recorded order before any plugin arms one: actions at the same millisecond run in recorded order and before plugin timers of that millisecond.
- No plugin imports `@ridrs/replay` (dependency-cruiser).

## Consequences

- The replay is deterministic in itself: replaying twice gives deep-equal results.
- **Real-time recordings are not reproduced exactly.** With the system clock, time passes during a run-to-completion cascade (a raw notification is stamped 1 ms after its `receivedAt`, physics step 0 a few ms after the ride start) and timers fire late (a late physics step may see a later measurement). A virtual clock reads exactly the due times. Recordings made with a wall-paced virtual clock (the automated e2e) replay identically; recordings of the system clock do not. See [recording-and-replay.md](../architecture/recording-and-replay.md#real-time-recordings) for the open options.
