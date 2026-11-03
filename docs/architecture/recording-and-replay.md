<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# Recording and Replay (Phase 9)

The event bus is the ride's complete, ordered history, and the raw device bytes are its root. Recording is one host-level tap, not code in every plugin. A replay feeds the **same bytes** through the **current** device, metric, temporal and physics code and compares every derived event with the recording.

```text
 BLE bytes ─► @ridrs/ble-peripheral link ─► device.raw-notification ─┐
               device plugins ─► measurement.* ─► metric.* ─► physics.* ┤ event bus ─► ctx.host.observe
 UI input ─► ui-bridge ─► activity.start-/finish-requested ────────────┘          (permission observe-host)
                                                                                   │
           recording-session ─ storage.app-files ─► recordings/<ride>.ridrs.jsonl ─► .ridrs ─► recording.completed
           export-fit ─ reads .ridrs ─ @ridrs/fit ─► recordings/<ride>.fit ─► export.fit-written
 CLI:      ridrs-headless recording inspect | replay | export-fit <file>
```

## Packages and plugins

| Part | License | Role |
|---|---|---|
| `@ridrs/contracts` | Apache-2.0 | manifest `permissions`, `ctx.host`, events `device.raw-notification`, `recording.completed`, `recording.failed`, `export.fit-written`, capabilities `storage.app-files`, `config.snapshot`, record schemas, hex codec |
| `@ridrs/recording` | AGPL-3.0-or-later (until the legal review) | file names, `RecordingWriter`, reader, recovery, snapshot builder, gzip (Web streams); imports contracts only |
| `@ridrs/fit` | AGPL-3.0-or-later (until the legal review) | `buildActivity`, `encodeActivity` ([fit-export.md](fit-export.md)) |
| `@ridrs/replay` | AGPL-3.0-or-later | headless replay and comparison on the host's `ReplayClock`; core, recording, microdiff |
| `recording-session` | AGPL-3.0-or-later | records every ride; requires `storage.app-files`, `config.snapshot`; permission `observe-host` |
| `export-fit` | AGPL-3.0-or-later | FIT export on `recording.completed` |
| `storage-files-node` / `storage-files-tauri` | AGPL-3.0-or-later | `storage.app-files` in Node (env-paths, `RIDRS_DATA_DIR`) and in the Tauri app container |

## Recording lifecycle

1. From `initialize`, `recording-session` observes every event and diagnostic and keeps a rolling 60 s pre-roll (plus the latest connection state per device).
2. On `activity.state-changed` `running` it creates `<name>.ridrs.jsonl` with header, snapshot and pre-roll, then records live. Lines are queued in order and appended every 1000 ms; the bus is never blocked.
3. On `finished` it records the rest of that cascade, flushes, writes the footer, gzips to `.ridrs`, reads it back and checks header, footer and line count, removes the `.jsonl` and publishes `recording.completed` (`distance` from the last `physics.state`).
4. A storage error reports `recording-failed` once and publishes `recording.failed`; recording stops for that ride, the ride goes on.
5. At host start, every orphaned `.ridrs.jsonl` is recovered (`recording-recovered`) and announced with `recording.completed`, which also triggers its FIT export.

Without a ride nothing is written. Recording is always on (no settings, no retention policy yet). The main screen shows "Ride saved" with distance (km), duration (`m:ss`) and the file names (`ride-saved*` test ids), or "Ride could not be saved".

## Replay

`replay(recording, { sources, capabilities, events, replace? })` runs the recording through the **same host and turn queue** as live, on a `ReplayClock` ([time-and-scheduling.md](time-and-scheduling.md)):

1. Composes a host from the current plugin sources with the **recorded plugin set** (plugins `started` in the snapshot), minus plugins whose manifest type is `transport`, `storage`, `recording`, `export` or `ui`, plus the in-memory plugin `replay-ble-central`: a `ble.central` that finds nothing. `replace` swaps a recorded plugin for another (e.g. a probe). The host gets the recorded `runId`, so ids reproduce.
2. Starts it at the first recorded record's time.
3. Injects every recorded **input** (`input: true`: BLE notifications and connection states, rider input, results of asynchronous work) with its recorded time, id, source and payload, in recorded order; unknown types are injected opaquely. Inputs from the replay host's own plugins (their I/O) are dropped. Recordings from before the input queue carry no flag: there, anything from outside the recorded plugins (and not `core.*`) counts as an input.
4. Advances the replay clock to `endedAt`, observing through the same tap as the recorder. Tasks and inputs run in the same order as live.

**Comparison:** events with `startedAt ≤ timestamp ≤ endedAt`, per `(type, source)` stream in order, exact equality of timestamp, payload and, when the recording carries its `runId`, envelope id. Not compared: inputs, `device.connection-changed`, `core.*`, `seq` (the replay host runs fewer plugins), streams of excluded plugins. The result has `identical`, per-stream counts and the first difference by timestamp (type, source, index, path: `timestamp`, `id` or a JSON path into the payload, both values).

**Configuration:** the replay reports plugin version changes, missing and added plugins and differing, missing or added `config.snapshot` sections (as JSON paths). Sections of excluded plugins are not compared. Nothing is applied.

**Guarantees:** replaying twice gives deep-equal results. A live recording, on real timers too, replays to identical derived events when the pre-roll covers the temporal layer's memory (60 s), and when the app ran shorter than that, the recording contains everything since host start (the recorder observes from `initialize`), which also suffices. Otherwise (e.g. a recovery after a crash during the pre-roll) the comparison reports where results diverge. Proven by `tests/unit/live-replay-determinism.test.ts` (late wake-ups, computing time, asynchronous jittered input, late measurements) and the real-timer e2e.

## CLI

```text
ridrs-headless recording inspect <file>                    header, plugins, duration, distance, counts, diagnostics, status   0 | 2
ridrs-headless recording replay <file> [--json] [-p dir]   config differences, streams, "identical" or the first difference   0 | 1 | 2
ridrs-headless recording export-fit <file> [-o out.fit]    the written file and its record count                              0 | 2
```

The CLI's `export-fit` runs the same three calls as the plugin (`readRecording`, `buildActivity`, `encodeActivity`): byte-identical output.
