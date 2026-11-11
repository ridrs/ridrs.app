<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# FIT Test Vectors

FIT files for ridrs' own FIT decoder (`@ridrs/fit`) and the FIT workout importer (`@ridrs/workout`), ADR 0084.

## How they are made

Every `*.fit` here is **written by hand** as an annotated hex file `*.fit.hex` from the public FIT protocol documentation and the public FIT profile 21.218, and assembled by [`assemble.ts`](assemble.ts) (its header describes the syntax: hex bytes, typed little- or big-endian integers, padded strings, and placeholders for the data size, the header CRC and the file CRC). No file is made by ridrs' own encoder or by the Garmin FIT SDK, and no SDK code was used to make them.

`vectors.test.ts` checks that every `.fit` is exactly what its `.fit.hex` says. After changing a `.fit.hex`:

```bash
WRITE_FIT_VECTORS=1 npx vitest run packages/workout/test-vectors/fit
```

The tests also read every vector with the official Garmin FIT SDK (a devDependency of the tests only, ADR 0034) and compare it with ridrs' decoder message by message. Workout files made by the SDK's encoder are generated at test time only and never committed.

## Files

All files: hand-written by the ridrs contributors, licence **CC-BY-SA-4.0**.

| File                                 | What it covers                                                                                                                                                                                                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `repeat-cadence.fit`                 | "VO2max 5x4": warm-up, 5 × (4 min at 115 % FTP with a secondary cadence target of 95–105 rpm, 4 min at 50 %), cool-down with an open target; `repeat_until_steps_cmplt`, invalid values, strings                                                             |
| `durations.fit`                      | Every duration type of a cycling step: time, distance, calories, open, heart rate below (% max) and above (bpm + 100), power below (% FTP) and above (W + 1000), averaged power (`power_3s_greater_than`, `power_lap_less_than`)                             |
| `repeats.fit`                        | A repeat nested in a repeat, and every `repeat_until_*` type: steps, time, distance, calories, heart rate below and above, power below and above                                                                                                             |
| `targets.fit`                        | Every target type: power zone, % FTP range, 1250 = 250 W, 1200–1220 = a 200–220 W range, heart rate zone, % max and bpm + 100, cadence, speed, speed zone (no place in the model), open, `power_3s`, `power_lap`, secondary targets (heart rate, power zone) |
| `big-endian.fit`                     | A 12-byte header without header CRC, all messages big-endian (architecture 1), the `virtual_activity` sub sport                                                                                                                                              |
| `developer-fields.fit`               | Protocol 2.0: `developer_data_id`, `field_description` and a step with a developer field; a byte array                                                                                                                                                       |
| `activity-compressed-timestamps.fit` | A FIT **activity** (not a workout): records with compressed timestamp headers, one rolling over the 32-second window; invalid values; an array field the profile does not know                                                                               |
| `running.fit`                        | A running workout: refused as not cycling                                                                                                                                                                                                                    |
| `bad-crc.fit`                        | A workout with a wrong file CRC: refused                                                                                                                                                                                                                     |
| `truncated.fit`                      | A workout cut off inside the workout message: refused                                                                                                                                                                                                        |
