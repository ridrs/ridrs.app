<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# intervals.icu text test vectors

The workout text of the intervals.icu workout builder, as it is pasted into a description. The syntax is described in the intervals.icu forum: "Workout Builder Syntax Quick Guide" (https://forum.intervals.icu/t/workout-builder-syntax-quick-guide/123701) and "Workout builder" (https://forum.intervals.icu/t/workout-builder/1163). `RPE`, `maxeffort` and `intensity=` are not described there; the importer reads them leniently (see `src/codecs/text/intervals.ts`).

Source and licence of every file: hand-written, CC-BY-SA-4.0, written for ridrs. No workout of intervals.icu or its users is included. The files have no name of their own, so the importer takes the name from the file name.

| File                       | What it shows                                                                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sweet-spot.txt`           | Sections, a ramp, a repeat of two steps, cadence, ranges, a ramp with falling values                                                                                                                    |
| `zones-and-heart-rate.txt` | `Z2`, `Z3 HR`, `% LTHR`, `% HR`, `bpm` (single and range), time forms `1h` `1m30` `5m30s`, `intensity=`, watts range, trailing text, RPE, loose lines                                                   |
| `freeride-prompts.txt`     | `power:` lines, freeride (with a range), maxeffort, distances (km, mi, mtr), timed prompts with `<!>`, `Press lap`, a target with no unit (`MMP`), a ramp without a range, dash lines that are no steps |
| `many-repeats.txt`         | Repeats closed by a blank line or by a plain line                                                                                                                                                       |
| `repeat-zero.txt`          | A repeat of 0: refused (`bad-repetitions`)                                                                                                                                                              |
| `swim-pace.txt`            | A pace target: refused (`not-cycling`)                                                                                                                                                                  |
| `prose-only.txt`           | Text without steps: refused (`no-steps`)                                                                                                                                                                |

Each `<name>.golden.json` is the expected result of the import, checked by hand against the file.
