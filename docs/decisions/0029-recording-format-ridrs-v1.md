<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0029: Recording Format "ridrs recording v1" (JSON Lines + gzip)

## Context

Phase 9 records every ride: every bus envelope, every diagnostic, the raw device bytes and a configuration snapshot, so a ride can be replayed deterministically and exported as FIT. The format must hold every event unchanged, stay extensible, survive a crash while riding and run in Node and in a WebView.

| Requirement | JSON Lines + gzip (chosen) | SQLite | Protobuf / CBOR | FIT as storage |
|---|---|---|---|---|
| Holds **every** event and raw bytes, unchanged | ✅ payloads stored verbatim | ✅ | needs a schema per event | ❌ fixed profile, lossy |
| Extensible without breaking readers | ✅ unknown kinds and fields are ignored | migrations | schema evolution rules | developer fields only |
| Append while riding, crash-tolerant | ✅ one line per record; a torn last line is dropped | ✅ (journal) | framing needed | ❌ CRC at the end |
| Runtime-neutral (Node, WebView, Tauri) | ✅ no native code | native module per runtime | ✅ | ✅ |
| Readable for debugging | ✅ `zcat … \| jq` | tools needed | ❌ | tools needed |
| Exact numbers | ✅ JSON round-trips IEEE-754 doubles exactly | ✅ | ✅ | scaled integers |
| Size (≈1 h) | ≈ 80 MB raw JSON → ≈ 8–12 MB gzip (estimate) | similar | smaller | small |

## Decision

- JSON Lines, one record per line, kinds `header`, `snapshot`, `event`, `diagnostic`, `footer` (spec: [ridrs-recording-v1.md](../formats/ridrs-recording-v1.md)). While riding `recordings/<name>.ridrs.jsonl` (plain, appended about every second); after finish `recordings/<name>.ridrs` (the same lines, gzip). Media type `application/vnd.ridrs.recording+json-seq; compression=gzip`.
- Payloads are stored verbatim; readers validate the payloads of the event types they know. Unknown kinds and fields are ignored, so additions keep `formatVersion: 1`; a reader refuses higher versions (`recording-unsupported-version`).
- zod schemas in `packages/contracts/src/recording.ts`; `docs/formats/ridrs-recording-v1.schema.json` is generated from them (`scripts/generate-recording-schema.ts`), a Vitest test fails on drift.
- No database, protobuf, CBOR, Parquet or zip library.

## Consequences

- Every event payload must be JSON-serializable without loss; a Vitest test round-trips every event definition of the contracts.
- Phase 8's trainer commands fit as new event types (`device.raw-write`, `trainer.command`) without a format change. (2026-11-05: they are real, with `device.raw-read` and `device.raw-write-failed` as inputs; [ADR 0056](0056-ftms-trainer-control.md).)
- The file size per 10 minutes is to be measured in the manual check (the estimate is dominated by `physics.state-batch`, 20 events/s).
