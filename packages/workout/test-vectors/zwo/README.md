<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ZWO test vectors

Zwift has no public specification of its workout files. These files are hand-written for ridrs from what the format's public descriptions and the many third-party tools that read it show: a `workout_file` with `author`, `name`, `description`, `sportType`, `tags` and a `workout` of `Warmup`, `Ramp`, `Cooldown`, `SteadyState`, `SolidState`, `IntervalsT`, `FreeRide` and `MaxEffort` steps with `textevent` children.

No file here is a Zwift workout or made from one (LICENSING.md, section 6a). Source and licence of every file: hand-written, CC-BY-SA-4.0, written for ridrs.

| File                             | What it shows                                                                                                                                        |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sweet-spot-3x12.zwo`            | Metadata, tags, Warmup and Cooldown ramps, text events, cadence                                                                                      |
| `intervals-free-max.zwo`         | `IntervalsT` with cadence and resting cadence, FreeRide with and without FlatRoad, Ramp with a cadence range, MaxEffort, power 0.07 (no float noise) |
| `distance-and-unknown-parts.zwo` | `durationType` distance, CDATA, unknown elements and attributes everywhere, a text event with extras, an `IntervalsT` with cues                      |
| `run-workout.zwo`                | A running workout: refused (`not-cycling`)                                                                                                           |
| `broken-unclosed.zwo`            | Not well-formed XML: refused (`invalid-xml`)                                                                                                         |
| `missing-duration.zwo`           | A step without `Duration`: refused (`missing-attribute`)                                                                                             |
| `not-a-workout-file.zwo`         | Another XML document: refused (`not-zwo`)                                                                                                            |
| `bad-power.zwo`                  | A non-numeric power: refused (`bad-number`)                                                                                                          |

Each `<name>.golden.json` is the expected result of the import (`importZwo` with the file name as option), checked by hand against the file. Diagnostics are listed by severity, code and place; the English messages are not part of the golden file.
