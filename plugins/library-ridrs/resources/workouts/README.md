<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# Built-in workouts

The workouts that ship with ridrs, the library of the provider `ridrs` (plugin `library-ridrs`, [ADR 0086](../../../../docs/decisions/0086-built-in-workout-catalogue.md)).

```
resources/workouts/
  <id>.json              canonical ridrs workout v1, shipped, read only
  sources/               the sources as delivered (ZWO, FIT); provenance, not shipped
    <name>.zwo
    <name>.meta.json     what the source lacks: author, license, focus, category, sport
```

- Format: [ridrs workout v1](../../../../docs/formats/ridrs-workout-v1.md). At run time only the `<id>.json` files are loaded; `sources/` is not imported by any module, so no bundle contains it.
- "Edit" in the app makes a copy; the built-in files are never changed on a device.

## Licence rules

- Every workout is **CC-BY-SA-4.0**, with `author` and `license` in its metadata (the meta file gives them).
- **No workouts of Zwift, TrainerRoad, Wahoo SYSTM or any other third party, converted or not** ([LICENSING.md](../../../../LICENSING.md), section 6a). Only workouts the maintainer made, or whose author allows CC-BY-SA-4.0, go in; a review refuses anything else.
- Content whose licence is unclear is not shipped.

## Adding a workout

1. Put the file in `sources/` as `<name>.zwo` or `<name>.fit` (the name becomes the id) and write `sources/<name>.meta.json`, for example:
   ```json
   { "sport": "virtual-ride", "author": "ridrs", "license": "CC-BY-SA-4.0", "focus": "threshold", "category": "Threshold" }
   ```
2. Run `pnpm workouts:convert`. It writes `<name>.json` with the same importers as the rider's import and is deterministic.
3. Add the JSON import to `catalogue.ts` of the plugin. The unit test fails when a file is missing there, when a canonical file does not match its source (a forgotten conversion), or when author or licence are missing.

ZWO has no nested repeats, watt or heart rate targets, lap-button or `until` steps: a nested repeat is written out in the source (the outer repeat unrolled, the inner one an `IntervalsT`).
