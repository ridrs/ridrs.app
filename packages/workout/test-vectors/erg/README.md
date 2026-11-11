<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ERG test vectors

The ERG format (CompuTrainer course files, read by many trainer programs) has no official specification. These files are hand-written for ridrs from what such files look like and what TrainerRoad's help article "Creating a Workout from an ERG or MRC File" describes: `[COURSE HEADER]` with `KEY = value` lines and the column line `MINUTES WATTS`, `[COURSE DATA]` with `minute value` points, `[COURSE TEXT]` with `seconds text seconds`.

Source and licence of every file: hand-written, CC-BY-SA-4.0, written for ridrs. No file of a service or a third party is included.

| File                    | What it shows                                                                                                                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `threshold-2x10.erg`    | Watts, `FTP`, ramps, jumps (same minute twice), course text over four steps                                                                                                                                                                       |
| `irregular.erg`         | CRLF, spaces instead of tabs, a first minute other than 0, a point twice, unknown header lines, an unknown section, lines outside sections, text without tabs; the file's points are kept in the extensions because the steps cannot rebuild them |
| `percent-column.erg`    | An ERG file whose column line says `PERCENT`: stays percent, with a warning                                                                                                                                                                       |
| `backwards-minutes.erg` | Minutes that go back: refused (`points-out-of-order`)                                                                                                                                                                                             |
| `bad-point.erg`         | A point that is not two numbers: refused (`bad-point`)                                                                                                                                                                                            |
| `one-point.erg`         | Only one point: refused (`too-few-points`)                                                                                                                                                                                                        |
| `not-a-course.erg`      | Not a course file: refused (`no-course-data`)                                                                                                                                                                                                     |

Each `<name>.golden.json` is the expected result of the import, checked by hand against the file.
