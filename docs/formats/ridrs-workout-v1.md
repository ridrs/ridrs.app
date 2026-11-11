<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ridrs workout v1

A ridrs workout is one structured cycling workout in the canonical format every source maps to without loss: ZWO, FIT, ERG, MRC, TCX and intervals.icu. The built-in catalogue ships in it, the rider's own and imported workouts are kept in it, and every export starts from it.

- Media type: `application/vnd.ridrs.workout+json`; file name `<id>.json`
- JSON Schema: [ridrs-workout-v1.schema.json](ridrs-workout-v1.schema.json) (generated from `packages/contracts/src/workout.ts` by `scripts/generate-workout-schema.ts`; a test fails when it is out of date)
- Decision record: [ADR 0081](../decisions/0081-canonical-workout-format.md); the plan: [structured-workouts.md](../ideas/structured-workouts.md), section 4

## Three Layers

| Layer | Content | Used for |
|---|---|---|
| 1. Typed model | Durations, targets, ramps and ranges, repeats, cues, metadata | Showing, riding, editing, export to any format |
| 2. `extensions.<format>` | Per workout and per step: what the source holds and layer 1 has no field for | An export to the **same** format restores it |
| 3. Original file | The imported bytes, kept as an app file and referenced by `source.originalHash` | Provenance; importing again with a better parser |

After an edit, layers 1 and 2 hold; the original file stays as provenance only.

## Example

```json
{
  "format": "ridrs-workout",
  "version": 1,
  "id": "sweet-spot-3x12",
  "name": "Sweet Spot 3×12",
  "sport": "virtual-ride",
  "author": "ridrs",
  "license": "CC-BY-SA-4.0",
  "focus": "sweet-spot",
  "source": { "kind": "builtin", "format": "zwo", "fileName": "sweet-spot-3x12.zwo" },
  "steps": [
    {
      "kind": "interval", "id": "1", "intensity": "warm-up",
      "duration": { "kind": "time", "seconds": 600 },
      "effort": { "kind": "target",
        "primary": { "unit": "percent-ftp", "start": { "low": 50, "high": 50 }, "end": { "low": 75, "high": 75 } } }
    },
    {
      "kind": "repeat", "id": "2", "until": { "kind": "count", "reps": 3 },
      "steps": [
        { "kind": "interval", "id": "2.1", "duration": { "kind": "time", "seconds": 720 },
          "effort": { "kind": "target", "primary": { "unit": "percent-ftp", "start": { "low": 90, "high": 90 } } } },
        { "kind": "interval", "id": "2.2", "intensity": "recovery", "duration": { "kind": "time", "seconds": 240 },
          "effort": { "kind": "target", "primary": { "unit": "percent-ftp", "start": { "low": 55, "high": 55 } } } }
      ]
    }
  ]
}
```

## Rules

- **A range is not a ramp.** A target has a `start` range; `low = high` is an exact value, `low < high` means "stay between". With an `end` range the target is a ramp, linear from `start` at the start of the step to `end` at its end.
- **No conversion.** A target keeps the unit of its source: `watts` stay watts, `percent-ftp` stays %, a zone target (`power-zone`, `hr-zone`) keeps the 1-based zone number. % FTP and zones are resolved to watts only when a ride starts, with the athlete profile of that moment ([ADR 0082](../decisions/0082-zones-in-the-athlete-profile.md)).
- **Units:** `percent-ftp`, `watts`, `power-zone`, `percent-lthr`, `percent-max-hr`, `bpm`, `hr-zone`, `rpm`, `meters-per-second`, `percent-threshold-speed`, `rpe` (1–10).
- **Efforts:** `target` (a primary target and further `secondary` ones, such as cadence beside power), `free` (no target the trainer holds; `flatRoad` from ZWO) and `max-effort`.
- **Durations:** `time`, `distance`, `energy` (kcal), `open` (until the lap button) and `until` (a value above or below a bound). A repeat ends after a `count`, or like a FIT `repeat_until_*` step.
- **Ids** of steps are stable within the workout: the editor, the player and the calendar sync refer to steps by them. An importer gives them by path (`1`, `2`, `2.1`) unless the source has its own.
- **Derived, not stored:** duration (estimated and marked for distance, open and `until` durations), training load, intensity factor, normalised power, kJ, time per zone. What a source states about itself is kept in `declared`.
- **Built-in workouts** carry `author` and `license` (`CC-BY-SA-4.0`, [ADR 0086](../decisions/0086-built-in-workout-catalogue.md)).
- **Extensibility.** New optional fields are additive and keep `version: 1`; only an incompatible change increments it, and a reader refuses higher versions. Unknown fields are refused (`strict`), so that nothing a writer meant is silently dropped.
