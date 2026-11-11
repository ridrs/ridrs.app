<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0081: One Canonical Workout Format Without Loss (`ridrs-workout` v1, Model v2)

Status: accepted on 2026-11-11 by the maintainer ([structured-workouts.md](../ideas/structured-workouts.md), sections 3, 4 and 14).

## Context

The training contract knew targets in % FTP only, with `low`/`high` meaning a ramp, while FIT and intervals.icu often mean a range with the same two values. There were no watts, heart rate, zones, free ride, distance or lap-button durations. Importing ZWO, FIT, ERG, MRC, TCX and intervals.icu workouts with that model would lose information or convert units (watts to %) on the way in, and an export could not restore what the source had.

## Decision

- **One canonical format**, `ridrs-workout` version 1, is the typed model v2 of the contracts (`packages/contracts/src/workout.ts`): `Workout`, `WorkoutStep` (`interval` or `repeat`), `WorkoutTarget` with a `start` range and an optional `end` range (a range is not a ramp), `WorkoutEffort` (`target` with primary and secondary targets, `free`, `max-effort`), `WorkoutDuration` (`time`, `distance`, `energy`, `open`, `until`), the FIT intensity enum, cues, metadata and the source. JSON Schema and format document: [ridrs-workout-v1](../formats/ridrs-workout-v1.md).
- **Three layers** keep an import without loss: the typed model; `extensions.<format>` per workout and per step for what the model has no field for, restored by an export to the same format; the original file, kept as an app file and referenced by its hash.
- **No conversion on import.** Targets keep their unit; zone targets keep the zone number. % FTP and zones are resolved only when a ride starts, with the profile of that moment, and enter the ride as input. Exports convert only where the target format cannot express a unit, always with a warning.
- **Rule 3:** fields that no supported format delivers stay out of the model. Derived values (duration of non-time steps, training load, IF, NP, kJ, time per zone) are computed, not stored; what a source states is kept in `declared`.
- **Planned and library workouts** (`training.calendar`, `training.library`) carry their structure as model v2 steps. Their users change in the same phase: `planner-intervals-icu` reads a `workout_doc` into v2 without converting watts or dropping zone targets, and the Today tile computes watts beside % from the profile's FTP when it shows them.
- **`@ridrs/workout`**, a new package, holds the logic around the model: validation beyond the schema, metrics, resolving zones, the chart geometry and the codecs. It is **AGPL-3.0-or-later** (a training and workout engine, LICENSING.md section 2); the contract stays Apache-2.0.
- **Parsers:** ZWO and TCX with `fast-xml-parser` 5.11.2 (MIT, [ADR 0066](0066-incyclist-control-files-fast-xml-parser.md)); ERG, MRC and intervals.icu text with own line parsers and an own grammar (ridrs domain logic, rule 2); FIT with the own decoder ([ADR 0084](0084-own-fit-decoder.md)). No new library.
- Steps have **stable ids**; importers give them by path (`1`, `2.1`) unless the source has its own.

## Consequences

- Every importer is a pure function `Uint8Array | string → Result<Workout[], Diagnostics>`, proven by round trips and cross checks against real or hand-written files from the public specifications in `packages/workout/test-vectors/`, broken ones included.
- The JSON Schema is generated from the zod schemas; a test fails when it is out of date.
- Workouts in watts are ridden in watts; a workout in % needs an FTP to be ridden in ERG.
