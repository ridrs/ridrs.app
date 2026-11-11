<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0086: The Built-In Workout Catalogue: Sources, Licence and Conversion

Status: accepted on 2026-11-11 by the maintainer ([structured-workouts.md](../ideas/structured-workouts.md), sections 3, 7 and 14, F4 and A1).

## Context

ridrs needs workouts of its own: the Training area shows placeholders. The maintainer has their own workouts, made with AI and ridden on intervals.icu, and delivers them as FIT or ZWO files. Workouts of Zwift, TrainerRoad, Wahoo SYSTM and others must never ship, converted or not (LICENSING.md section 6a).

## Decision

- The catalogue lives in a new host plugin **`library-ridrs`**, the provider `ridrs` of `training.library` (built-in and the rider's own workouts):
  - `resources/workouts/<id>.json`: canonical `ridrs-workout` v1 files, **shipped**, read only; "Edit" makes a copy.
  - `resources/workouts/sources/`: the sources as delivered (FIT, ZWO), with `<name>.meta.json` beside each for what the source lacks (author, licence, focus): provenance, **not shipped**.
  - `resources/workouts/README.md`: the format, the licence rules and how to add workouts.
- **Licence:** the built-in workouts are **CC-BY-SA-4.0**, with `author` and `license` in each file's metadata. Whether purely AI-generated content is protected by copyright is open; the notice touches no one else's rights and does no harm.
- **Conversion:** `pnpm workouts:convert` writes the canonical files from the sources with **the same importers** as the rider's import. A test checks that every canonical file is valid and matches its source: a forgotten conversion fails the build. At run time the catalogue loads canonical files only.
- **Working material:** five example workouts as ZWO sources (Sweet Spot 3×12, VO2max 5×4, Over-Unders 3×(4×3′), Endurance 75 with drills, Microbursts 30/30), written for ridrs under CC-BY-SA-4.0. They replace the placeholders and are replaced or joined by the maintainer's workouts later.
- The conversion script is AGPL-3.0-or-later, like the plugin.

## Consequences

- Watt and heart rate targets, the lap button and `until` durations cannot be written in ZWO; the package's test vectors cover them, not the catalogue.
- A workout of a third-party service is refused in review; the README says so.
