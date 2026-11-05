<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0055: The Recording Is the Session Journal; Durability

Status: accepted on 2026-11-05 and implemented the same day, for [ADR 0052](0052-persistence-domains-and-plan.md). Extends [ADR 0029](0029-recording-format-ridrs-v1.md) and [ADR 0031](0031-app-files-storage-capability.md).

## Context

`recording-session` appends the open recording once a second without flushing it to the disk: after a process crash about a second is lost, after a power loss an unknown amount. To continue a ride after a crash ([ADR 0057](0057-continuing-an-interrupted-ride.md)), the open recording has to be a journal whose committed part is known and bounded.

## Decision

- **The open `.ridrs.jsonl` is the session journal.** No second log. **A line is committed once it is complete**; a torn last line is not (the reader's rule since ADR 0029).
- **`AppFiles.sync(path)`**: resolves once what was appended to `path` is on the disk. Node: `FileHandle.sync()` (`fsync`; on macOS not a full flush, Node offers no `F_FULLFSYNC`; headless runs are not the target). Tauri: the app command `app_file_sync` in Rust (`File::sync_all`, `F_FULLFSYNC` on Apple platforms), below `recordings/` only.
- **Policy**: append once a second as before; **sync every 5 s and right after appending an activity lifecycle event** (`activity.state-changed`: start, pause, resume, interruption). Syncs run in the recorder's write chain, never on the turn queue: inputs are never held back until they are committed.
- **Append batches end at turn boundaries.** The recorder appends from a timer, and a turn runs synchronously with everything it publishes, so a batch never ends inside a turn except by a torn write.
- **What is committed for recovery**: the complete lines, minus every line from the first event of the last event time on. All events of one logical time are then either all there or all gone: the turns of a time are complete, so a recovery that replays them writes nothing twice and misses nothing ([ADR 0057](0057-continuing-an-interrupted-ride.md)).
- **Stated guarantee**: on a process crash at most the last ~1 s of the journal is lost, on a power loss at most the last ~6 s, on storage that honours flush requests. The recovered ride is the ride as if those inputs had never arrived. Nothing is claimed for disks or file systems that ignore flushes.

## Consequences

- The memory storage of the tests keeps what was synced apart from what was only appended, so a scenario can lose the unsynced tail like a power loss.
- About 720 full flushes an hour while riding, off the turn queue.
- Effects that leave ridrs and must not be repeated (trainer commands, uploads, later) must be idempotent with respect to the current state, or wait for the journal (an outbox). None exists today.
