<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0057: Continuing an Interrupted Ride

Status: accepted on 2026-11-05 (always ask, chosen by the maintainer) and implemented the same day, for [ADR 0052](0052-persistence-domains-and-plan.md) (phase P5). Builds on [ADR 0055](0055-the-recording-is-the-session-journal.md) and [ADR 0056](0056-pause-and-resume-a-ride.md).

## Context

After a crash, `recording-session` seals the open recording as `recovered` at the next start: the ride is over. The simulation is deterministic: the state after any committed prefix of the journal is the state the live ride had then, and the replay host ([ADR 0032](0032-replay-virtual-clock.md)) already rebuilds it.

## Decision

- **Ask.** At start, `recording-session` reads every open recording. The newest is offered with `recording.recoverable-changed { ride: { sessionId, file, startedAt, lastRecordAt, distance?, continuable, reason? } }`; older ones are sealed as before. `continuable` is false when the journal's committed part has no running ride, or when a simulation plugin of the recorded set is missing or has another version now (`reason`: `no-ride`, `plugin-missing`, `plugin-version-changed`): different code could compute a different state. Input-side plugins (types `transport`, `storage`, `recording`, `export`, `ui`) may differ.
- **The main screen** (`ui-ride-recovery`, in `main/panel`) offers **Continue ride** and **Finish ride**, Continue focused first; without `continuable` only Finish, with the reason. `recording.finish-requested` seals the ride as `recovered` (today's path). **Headless continues on its own.**
- **Continue** is done by the composition root (`recording.continue-requested`): it closes the host and composes a **continuing host** with `PluginHostOptions.continueFrom: { start, runId, file }`:
  1. The host runs on a `LiveClock` that is **held**: like a replay clock, time moves only by `advanceTo`. Every plugin starts, the input side too; inputs of plugins (scans, connections, measurements) wait while the clock is held.
  2. The root injects every committed input at its recorded time with its recorded id ([ADR 0055](0055-the-recording-is-the-session-journal.md): the last event time is dropped), advances to the last committed time, publishes `activity.interrupted` there and advances once more: the ride is `paused` (reason `interrupted`), the physics task cancelled.
  3. **`goLive()`**: the clock is released to its time source. Logical time jumps from the interruption to now; nothing simulated runs in the gap, the temporal layer's deadlines in it run at their times (series go stale). The inputs that waited enter now. Input ids continue after the highest recorded one.
  4. `recording-session` sees `continueFrom.file` in `ctx.host.describe()`: it leaves the file out of its start-up recovery, ignores what the held phase publishes, and from the `activity.interrupted` input on appends to the same file: it rewrites the file to its committed part first and numbers lines on from its last `seq`.
- **The ride goes on paused**: same `sessionId`, step numbers and distance continue; the devices reconnect as new live connections (the remembered devices of [ADR 0054](0054-plugin-settings-and-remembered-devices.md)); the rider resumes with **Resume**. Headless stays paused too, until `activity.resume-requested` arrives; resuming on the first fresh power reading is not built.
- **The interruption is an upper bound**: from the last committed record to the restart. The FIT export shows it as a pause.

## Consequences

- The core gains the held live clock and `continueFrom`; `@ridrs/replay` gains `continueRecording`, shared by `apps/native` and `apps/headless`.
- A replay of a continued ride is identical to the live run: the interruption is an input, and the replay clock passes the gap with no physics task.
- Nothing historical is sent to a device: the held phase lets the device plugins act, but their connections are new ones, and no command is replayed (none exists yet).
- No checkpoints: recovery time grows with the ride. P6 measures it.
