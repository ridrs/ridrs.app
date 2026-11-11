<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# Fixtures of the workout import scenarios

Workout files the import screen reads (`tests/features/ui/workout-import*.feature`). They are kept byte for byte (`.gitattributes`), because the scenarios check their hash.

All files but the ZIP are copies of the importer test vectors in `packages/workout/test-vectors/` (hand-written for ridrs from the public format descriptions, CC-BY-SA-4.0; see the READMEs there). No file is a workout of Zwift, TrainerRoad, Wahoo SYSTM or another service, and none was made by ridrs' own encoder.

| File                             | Source                                                                                                   | Used for                                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `files/sweet-spot-3x12.zwo`      | `zwo/` vector                                                                                            | A ZWO workout in % FTP; its file name gives the id of a built-in workout |
| `files/intervals-free-max.zwo`   | `zwo/` vector                                                                                            | Free ride and max effort steps                                           |
| `files/threshold-2x10.erg`       | `erg/` vector                                                                                            | An ERG course in watts                                                   |
| `files/over-unders.mrc`          | `mrc/` vector                                                                                            | An MRC course in % FTP                                                   |
| `files/watts-3x10.fit`           | hand-written, `files/watts-3x10.fit.hex`, assembled with `packages/workout/test-vectors/fit/assemble.ts` | A FIT workout with every target in watts                                 |
| `files/run-only.tcx`             | `tcx/` vector                                                                                            | A running workout: refused                                               |
| `files/broken-unclosed.zwo`      | `zwo/` vector                                                                                            | Not well-formed XML: refused                                             |
| `files/sweet-spot.txt`           | `intervals/` vector                                                                                      | A pasted intervals.icu text                                              |
| `files/zones-and-heart-rate.txt` | `intervals/` vector                                                                                      | A pasted text with steps by heart rate and by RPE                        |
| `files/three-workouts.zip`       | `intervals-free-max.zwo`, `threshold-2x10.erg` and `over-unders.mrc`, zipped with `zip -X`               | A ZIP with three workouts                                                |

`plugins/fixture-ui-import-host` is a screen `main` with a button that opens the import screen, as the Training area will.
