<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0111: A Ride's Summary in Its File Name

Status: proposed on 2026-11-26. Amends the file names of [the recording format](../formats/ridrs-recording-v1.md) and the start of `history-ridrs` ([ADR 0076](0076-done-workouts-from-every-provider.md)).

## Context

The Mac app shows a dark window for about 8 s at every start. A measurement on 2026-11-26 (dev build, timestamps in the plugin host) found the cause:

- `history-ridrs` reads every sealed recording in full in its `start` hook: gunzip, then each line parsed as JSON. The host awaits it before it starts the next plugin, and the shell mounts only after all plugins have started.
- With 17 recordings (220 MB gzip) this took 7.64 s of the 7.8 s that all plugins took to start. First paint was at 8.5 s.
- A recording is the ride's whole event log. A 90-minute ride is 374 MB of JSON, 306 MB of it `physics.state-batch` (about 20 per second). So the start grows with every ride, and with long rides fastest.

The history needs a few values per ride: the session, the start, the time zone offset, the duration, the workout name and the planned entry. They are fixed once the ride is sealed.

## Decision

**The folder listing is the index.** Each sealed recording stays one file per ride. Its name holds everything the history needs, so `history-ridrs` lists `recordings/` and reads no file. There is no index file and no cache.

### The name

```
ride-<local start>~<session>~<duration>s~<plan>~<name>.ridrs
```

| Field | Content | Example |
|---|---|---|
| local start | The start in the rider's local time with its offset, ISO 8601 basic with milliseconds: `yyyyMMdd'T'HHmmss.SSS±hhmm`. The date the rider sees, the exact `startedAt` (the merge of providers matches rides by it) and the time zone offset. | `20261124T112908.647+0100` |
| session | The session id with `:` written as `_` (its `linkIdOf`, the history entry's `externalId` already), and a `_` of its own as `%5F`. | `295f70db9baaa0e0_activity-session_1795516148647_0` |
| duration | Whole seconds from `startedAt` to the footer's `endedAt`, `-` without a footer. | `5431s` |
| plan | `-`, or the planned entry as `<provider>=<id>`, with the id encoded as the name is. | `intervals.icu=146155281` |
| name | The workout's name, else `Ride`. Encoded and capped (see below). Always the last field. | `The One That Stays Controlled 🎚️` |

Example: `ride-20261124T112908.647+0100~295f70db9baaa0e0_activity-session_1795516148647_0~5431s~intervals.icu=146155281~The One That Stays Controlled 🎚️.ridrs`

- **Separator `~`.** It is not in a stamp, a session id, a duration or a provider id (`^[a-z0-9]+([.-][a-z0-9]+)*$`). In the plan id and the name it is encoded.
- **Encoding of the plan id and the name.** UTF-8, as is, except `% / \ : * ? " < > | ~` and the control characters, which are written as `%XX`. That set is what macOS, Android, iOS and Windows forbid or treat specially, plus the escape and the separator. Emoji and `×` stay readable in Finder.
- **The name is at most 100 bytes once encoded.** A longer one is cut at a grapheme boundary (`Intl.Segmenter`) and ends with `…`. The history then shows the cut name, and the full name stays in the recording. The longest name of the 17 recordings needs 154 bytes in all, and the limit of APFS, ext4 and f2fs is 255 bytes.
- **The session id comes back exactly**, whatever it holds: `_` → `:` and the `%XX` decoded. A session id of the app is `<16 hex digits>:<plugin id>:<ms>:<count>` (`PluginHost.nextId`) and holds no `_`, so its field reads as its `linkIdOf`.
- A `.ridrs` whose name does not parse (wrong stamp, duration or plan, or a `%` that is no escape) is not a v1 name (see Migration).
- **More fields later** go between `plan` and `name`, the name stays last. A reader takes the first four fields by position and the last as the name, so it reads a later name with fields it does not know.

### Where the name comes from

- While the ride runs nothing changes: `recordings/ride-<UTC stamp>-<id8>.ridrs.jsonl`, as now. The values of the name are not all known before the end.
- `seal` (recording-session) writes the `.ridrs` under the full name. `summaryOfText` (`@ridrs/recording`) takes the name from the open text: it parses the header, the footer and the lines of `activity.state-changed`, not the ride's events. This holds for `closeRide` and for `sealOrphan` (a recovered or finished interrupted ride).
- The `file` of `recording.ride` is that name, so `export-fit` and the history follow it.
- The FIT export is named like its recording, `<name>.fit` (`fitPathFor`, unchanged), so it carries the workout's name too.
- The screenshots keep their names, `ride-<UTC stamp>-screenshot_NN.jpg` ([ADR 0102](0102-screenshots-of-a-ride.md)): they are taken while the ride runs, and nothing lists them by ride.

### Readers

- **`history-ridrs`** builds each entry from the listing: `id` and `externalId` from the session, `date` and `startedAt` from the stamp, `durationSeconds`, `name`, `planned`. Its `start` lists the folder and reads no file. A ride saved later still comes through `recording.ride`, read from its name as well.
- **`deleteRecording`** checks the session field of the name instead of `-<id8>.ridrs`.
- Nothing else reads the names. `export-fit` reads the file it is given.

### Migration

- `history-ridrs` reads a `.ridrs` whose name is not a v1 name (the names before this ADR) once (`summaryOfText` of the gunzipped text) and renames it: the same bytes are written under the new name, then the old file is removed. Its FIT file is renamed with it. The app files have no rename; a crash in between leaves both, and the next start renames the old one again.
- This runs in the background after the start, one file at a time, and never in the `start` hook. The rides with v1 names are in the history at once. Each old ride joins it when it is renamed, and the history says `loading` until the last one is.
- A file that cannot be read stays as it is, with a warning, and is not in the history.

## Checked against the real recordings (2026-11-26)

All 17 recordings on the Mac were turned into v1 names with a script:

- Name length 92–154 bytes. Workout names with `⏳`, `🌬️`, `🎚️` and `×` are fine.
- In all 17, the session id has four parts and no `_`.
- 11 of the 17 are `recovered`, not `complete`. Both have a footer with `endedAt`, so both have a duration.

## Consequences

- The start no longer depends on the number or size of the rides. The history is there with the first frame.
- A rider sees what each file is in Finder: date, local time, duration and workout.
- What the history may show is limited to what fits in a name. A value that is not fixed at sealing, or that is long, does not belong in the name: the planned entry of a ride linked later, a description, or statistics with many values.
- A rider who renames a file by hand changes the history, or drops the ride from it if the name is no longer v1. Then the migration reads it once more and names it again.
- Not covered: the size of the recordings themselves (20 physics batches per second with the full `trainerLoad`).
