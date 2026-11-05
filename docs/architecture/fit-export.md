<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# FIT Export (Phase 9)

Every saved ride is exported as a FIT activity file next to its recording, by `export-fit` on `recording.completed` (and by `ridrs-headless recording export-fit`, byte-identical). ridrs writes FIT with its own encoder; the official Garmin FIT SDK only validates it in tests ([ADR 0034](../decisions/0034-fit-own-encoder-sdk-validation-only.md)).

## The activity model (`buildActivity`, pure)

From the recording's non-pre-roll events:

- **Record times:** `t_k = ceil(startedAt / 1000)·1000 + k·1000` for every `t_k ≤ endedAt`.
- **Power, cadence, heart rate:** the latest `metric.power` / `metric.cadence` / `metric.heart-rate` published at or before `t_k`; unavailable or none → invalid (omitted). Never 0.
- **Speed, distance:** the latest `physics.state-batch` sample with `at ≤ t_k`; none → invalid.
- **Session and lap:** start `startedAt`; total elapsed = `endedAt − startedAt`; total timer time = elapsed minus the pauses (ADR 0056; no records inside a pause); total distance = the last record distance; average speed = distance / timer time; max speed and average/max power, cadence, heart rate over the valid record values, rounded half up to the field resolution.

## The file (`encodeActivity`, pure)

Little-endian; 14-byte header (protocol 1.0, profile 21.218, header CRC); one definition per local message type before its first data message; file CRC-16 at the end. No compressed timestamps, no developer fields.

| Message | Content |
|---|---|
| `file_id` | type `activity`, manufacturer `development`, product 0, `time_created = endedAt` |
| `file_creator` | `software_version` from `ridrsVersion` (`0.1.0` → 0.10) |
| `event` | timer `start` at `startedAt`; timer `stop` at every pause and `start` at every resume; timer `stop_all` at `endedAt` |
| `record` × n | timestamp, heart_rate, cadence, distance (scale 100), speed and enhanced_speed (scale 1000), power |
| `lap` | one, the whole ride (trigger `session_end`) |
| `session` | one, `cycling` / `virtual_activity` |
| `activity` | `num_sessions = 1`, `local_timestamp` = `endedAt` + `timeZoneOffsetMinutes` |

FIT timestamps are seconds since 1989-12-31T00:00:00Z. Vitest cross-checks every message, field number, base type, scale and enum value, the CRC and determinism against the SDK; the features decode every exported file with `isFIT`, `checkIntegrity()` and `read()`.

Not in Phase 9: uploads, share sheet, FIT import, TCX/GPX, `device_info`, `hrv`, altitude, laps other than the ride.
