<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# TCX test vectors

Garmin's TrainingCenterDatabase v2 is public: https://www8.garmin.com/xmlschemas/TrainingCenterDatabasev2.xsd (`Workout`, `Step_t`, `Repeat_t`, the `Duration_t` types `Time_t`, `Distance_t`, `HeartRateAbove_t`, `HeartRateBelow_t`, `CaloriesBurned_t`, `UserInput_t`, and the `Target_t` types `None_t`, `Power_t`, `HeartRate_t`, `Cadence_t`, `Speed_t`). The files here are hand-written for ridrs from that schema (and Garmin's `PowerZone` types as devices and Garmin Connect write them). No file of Garmin or a service is included.

Source and licence of every file: hand-written, CC-BY-SA-4.0, written for ridrs.

| File                               | What it shows                                                                                                                                                    |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bike-intervals.tcx`               | Steps, a repeat, power zone and custom watts, cadence, lap button, notes, and the parts of the file that are kept (folders, creator, extensions, author)         |
| `heart-rate-distance-calories.tcx` | Distance, heart rate above and below (bpm and percent), calories, heart rate zone and custom ranges, a speed range, power in percent, the `LapButton_t` spelling |
| `unusual-targets-and-steps.tcx`    | A speed zone without a unit, an unknown target type and intensity, a nested repeat, extra attributes, elements and a note on steps                               |
| `running-and-biking.tcx`           | Three workouts, one of them running: the running one is skipped with a warning, the two rides get ids `-2` and `-3`                                              |
| `run-only.tcx`                     | Only a running workout: refused (`not-cycling`)                                                                                                                  |
| `activity-not-workout.tcx`         | An activity file with no workouts: refused (`no-workout`)                                                                                                        |
| `broken-repeat.tcx`                | A repeat without a count: refused (`bad-repetitions`)                                                                                                            |
| `broken-truncated.tcx`             | Cut off: refused (`invalid-xml`)                                                                                                                                 |

Each `<name>.golden.json` is the expected result of the import, checked by hand against the file.
