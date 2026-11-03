<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ridrs recording v1

A ridrs recording is the complete, ordered history of one ride: every event-bus envelope, every diagnostic, the raw device bytes, a configuration snapshot. It is the storage format; FIT is an export of it ([fit-export.md](../architecture/fit-export.md)).

- Media type: `application/vnd.ridrs.recording+json-seq; compression=gzip`
- JSON Schema of one line: [ridrs-recording-v1.schema.json](ridrs-recording-v1.schema.json) (generated from `packages/contracts/src/recording.ts`)
- Decision record: [ADR 0029](../decisions/0029-recording-format-ridrs-v1.md)

## Files

| File | Content |
|---|---|
| `recordings/<name>.ridrs.jsonl` | While a ride runs: UTF-8 JSON Lines, uncompressed, append-only, flushed about every 1 s. |
| `recordings/<name>.ridrs` | After finish: the same lines, gzip-compressed. The `.jsonl` is removed only after this file was written and read back. |
| `recordings/<name>.fit` | The FIT export. |

`<name>` = `ride-<startedAt as UTC yyyyMMdd'T'HHmmss'Z'>-<first 8 characters of the session id>`, e.g. `ride-20261101T100000Z-3f2a9c1d`.

Debugging: `gunzip -c ride-….ridrs | jq -c 'select(.kind=="event") | .envelope.type' | sort | uniq -c`.

## Records

Every line is one JSON object with a `kind`. The order of lines is the order of recording.

| Kind | When | Content |
|---|---|---|
| `header` | line 1, exactly once | `format: "ridrs.recording"`, `formatVersion: 1`, `ridrsVersion`, `sessionId`, `runId` (the host run; a replay reuses it), `startedAt`, `timeZoneOffsetMinutes` (of the host at start, east positive), `platform` (`runtime`: `node` \| `tauri`, `os`, `appVersion`), `prerollMs` |
| `snapshot` | line 2, exactly once | `host`: `ctx.host.describe()` at ride start; `sections`: every `config.snapshot` section by plugin id, sorted |
| `event` | every bus envelope, in publish order | `seq` (1, 2, …, shared with diagnostics), `preroll`, `envelope`: `{ id, type, source, timestamp, payload, seq, input?, receivedAt? }` verbatim; `input: true` marks external inputs, which a replay injects |
| `diagnostic` | every diagnostic while recording | `seq`, `at`, `code`, `pluginId?`, `message`, `details?` |
| `footer` | last line, exactly once | `status`: `complete` \| `recovered`, `endedAt`, `lastSeq`, `counts` (`events`, `diagnostics`, `byType`) |

## Rules

- **Extensibility.** Readers ignore unknown `kind`s and unknown fields. New kinds and fields are additive and keep `formatVersion: 1`. Only an incompatible change increments it; a reader refuses higher versions with `recording-unsupported-version`.
- **Payloads are stored verbatim** as published (they were validated by their event schema). Readers validate a payload when they know its event type. Events of unknown types (e.g. a future `trainer.command`) are kept opaque and still compared on replay.
- Payloads are **JSON-serializable without loss**; envelopes are serialized when observed.
- **Times** are epoch ms from the host clock, exactly as in the envelopes: no rounding, no conversion.
- **Binary data** appears only inside payloads, as lowercase hex (`device.raw-notification.data`).
- **Pre-roll.** Events of the 60 s before `startedAt` (plus the latest `device.connection-changed` per device older than that) come first with `preroll: true`, numbered from `seq` 1. The ride's first event (`preroll: false`) is the `activity.start-requested` that started it, then `activity.state-changed` `running`.
- **End.** The ride's events end with the run-to-completion cascade of its `finished` state (the final physics state and batch), then the footer.
- **Recovery.** An open `.ridrs.jsonl` found at host start loses a torn last line and gets a footer with `status: recovered` and `endedAt` = the last record's time.
