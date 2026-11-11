<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0084: Own FIT Decoder; FIT Workouts in `@ridrs/fit`

Status: accepted on 2026-11-11 by the maintainer; extends [ADR 0034](0034-fit-own-encoder-sdk-validation-only.md) ([structured-workouts.md](../ideas/structured-workouts.md), sections 1 and 8).

## Context

ridrs imports FIT workout files (`file_id.type = workout`) and exports workouts to FIT. ADR 0034 keeps Garmin's FIT SDK out of everything ridrs ships: its licence forbids distribution and any licence that requires source disclosure. `@ridrs/fit` has an own encoder only.

## Decision

- `@ridrs/fit` gets an **own decoder**, written from the public FIT protocol documentation and profile (21.218), like the encoder: file header and CRC, definition and data messages, normal and compressed timestamp headers, developer data fields read and kept opaque, little and big endian, invalid values per base type. It returns messages with their fields by number and name; it refuses a broken CRC or a truncated file with a diagnostic.
- The **FIT workout importer** in `@ridrs/workout` maps `workout` (26) and `workout_step` (27) to the canonical model: steps whose duration type repeats jump back and become `repeat` steps; every field without a place in the model goes to `extensions.fit`.
- The **encoder** learns `workout` and `workout_step` in the export phase.
- **@garmin/fitsdk** stays a devDependency of the root test workspace only (ADR 0034): it cross-checks the decoder (the same messages and fields from the same files) in tests. No code is copied from it or from any SDK.
- **Test vectors** in `packages/workout/test-vectors/fit/`: real workout files where their licence allows them in the repository, else hand-written ones from the public specification; never files made by ridrs' own encoder alone. Broken files are included.

## Consequences

- dependency-cruiser's `fit-sdk-only-in-tests` rule and `check-native-bundle.mjs` keep enforcing that the SDK is not shipped.
- `@ridrs/fit` stays AGPL-3.0-or-later (ADR 0034).
