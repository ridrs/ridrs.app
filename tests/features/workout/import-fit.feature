@workout
Feature: Importing a FIT workout
  A FIT workout file (file_id type "workout") is read with ridrs' own FIT decoder and becomes a
  workout in the canonical format (ADR 0081, 0084). Nothing is converted: % FTP stays % FTP, watts
  stay watts, a zone stays a zone. Steps that jump back become repeats; a custom low and high are a
  range, not a ramp. What the model has no field for is kept in the FIT extensions. Activities,
  other sports and broken files are refused with a reason.

  The files are the hand-written test vectors of packages/workout/test-vectors/fit, and workouts
  made by the official Garmin FIT SDK while the test runs.

  Scenario: A FIT workout with 5 × (4 min at 115 % with 95–105 rpm, 4 min at 50 %) is imported as a repeat with a cadence target
    When the FIT workout file "repeat-cadence.fit" is imported
    Then the FIT import gives the cycling workout "VO2max 5x4" with the sub-sport "indoor_cycling"
    And the FIT import has the top-level steps "0, 3, 4"
    And the FIT step "3" is "repeat 5 times"
    And the FIT repeat "3" holds the steps "1, 2"
    And the FIT step "1" is "240 s at percent-ftp 115–115 with rpm 95–105"
    And the FIT step "1" is named "On" with the intensity "interval"
    And the FIT step "2" is "240 s at percent-ftp 50–50"
    And the FIT step "4" is "open target for 600 s"

  Scenario: A target of 1250 is 250 W, not a percentage
    When the FIT workout file "targets.fit" is imported
    Then the FIT step "2" is "300 s at watts 250–250"

  Scenario: A custom target 200–220 W is a range, not a ramp
    When the FIT workout file "targets.fit" is imported
    Then the FIT step "3" is "300 s at watts 200–220"
    And the FIT step "3" has no ramp

  Scenario Outline: The FIT target "<name>" keeps its unit
    When the FIT workout file "targets.fit" is imported
    Then the FIT step "<id>" is "<step>"

    Examples:
      | id | name        | step                                                |
      | 0  | Zone 3      | 300 s at power-zone 3–3                             |
      | 1  | Sweet spot  | 300 s at percent-ftp 88–94                          |
      | 4  | HR zone 2   | 300 s at hr-zone 2–2                                |
      | 5  | HR %max     | 300 s at percent-max-hr 70–80                       |
      | 6  | HR bpm      | 300 s at bpm 140–150                                |
      | 7  | Cadence     | 300 s at rpm 85–95                                  |
      | 8  | Speed       | 300 s at meters-per-second 8–9                      |
      | 10 | Open        | open target for 300 s                               |
      | 11 | 3s power    | 300 s at watts 300–350 over 3s                      |
      | 12 | Lap power   | 300 s at percent-ftp 95–100 over lap                |
      | 13 | Two targets | 300 s at watts 200–210 with bpm 130–140             |
      | 14 | Two zones   | 300 s at hr-zone 3–3 with power-zone 2–2            |

  Scenario: A speed zone has no place in the model and is kept in the FIT extensions
    When the FIT workout file "targets.fit" is imported
    Then the FIT step "9" is "open target for 300 s"
    And the FIT step "9" keeps "targetType, targetValue" in its FIT extensions
    And the FIT import warns "unsupported-target"

  Scenario Outline: The FIT duration "<name>" is imported as it is
    When the FIT workout file "durations.fit" is imported
    Then the FIT step "<id>" is "<step>"

    Examples:
      | id | name        | step                                     |
      | 0  | Time        | open target for 300 s                    |
      | 1  | Distance    | open target for 5000 m                   |
      | 2  | Calories    | open target for 100 kcal                 |
      | 3  | Open        | open target until the lap button         |
      | 4  | HR below    | open target until percent-max-hr below 70 |
      | 5  | HR above    | open target until bpm above 160          |
      | 6  | Power below | open target until percent-ftp below 55   |
      | 7  | Power above | open target until watts above 300        |
      | 8  | 3s above    | open target until watts above 400        |
      | 9  | Lap below   | open target until percent-ftp below 80   |

  Scenario: An averaged power duration keeps its FIT duration type
    When the FIT workout file "durations.fit" is imported
    Then the FIT step "8" keeps "durationType" in its FIT extensions

  Scenario: A repeat in a repeat is nested
    When the FIT workout file "repeats.fit" is imported
    Then the FIT import has the top-level steps "0, 5, 7, 9, 11, 13, 15, 17, 19"
    And the FIT repeat "5" holds the steps "3, 4"
    And the FIT step "5" is "repeat 2 times"
    And the FIT repeat "3" holds the steps "1, 2"
    And the FIT step "3" is "repeat 3 times"

  Scenario Outline: A FIT repeat until <name> becomes a repeat with that end
    When the FIT workout file "repeats.fit" is imported
    Then the FIT step "<id>" is "<step>"
    And the FIT repeat "<id>" holds the steps "<body>"

    Examples:
      | id | name                 | step                                   | body |
      | 7  | a time               | repeat until 600 s                     | 6    |
      | 9  | a distance           | repeat until 10000 m                   | 8    |
      | 11 | an energy            | repeat until 300 kcal                  | 10   |
      | 13 | a heart rate above   | repeat until bpm above 170             | 12   |
      | 15 | a heart rate below   | repeat until percent-max-hr below 60   | 14   |
      | 17 | a power below        | repeat until watts below 150           | 16   |
      | 19 | a power above        | repeat until percent-ftp above 120     | 18   |

  Scenario: A big-endian file with a 12-byte header is read
    When the FIT workout file "big-endian.fit" is imported
    Then the FIT import gives the virtual cycling workout "Big endian"
    And the FIT step "0" is "1200 s at watts 250–250"
    And the FIT step "1" is "1000 m at percent-ftp 90–95"

  Scenario: Developer fields are kept opaque in the FIT extensions
    When the FIT workout file "developer-fields.fit" is imported
    Then the FIT step "0" keeps the developer field 0 of developer 0 with the bytes "0700"
    And the FIT workout keeps the messages "fileId, 207, 206" in its FIT extensions

  Scenario: A FIT workout made by the official FIT SDK is imported
    When a FIT workout of 3 × (30 s at 400 W, 30 s at 60 % FTP) made by the official FIT SDK is imported
    Then the FIT import gives the cycling workout "SDK 3x30" with the sub-sport "indoor_cycling"
    And the FIT repeat "2" holds the steps "0, 1"
    And the FIT step "2" is "repeat 3 times"
    And the FIT step "0" is "30 s at watts 400–400"
    And the FIT step "1" is "30 s at percent-ftp 60–60"

  Scenario: A FIT activity is refused as not a workout
    When the FIT workout file "activity-compressed-timestamps.fit" is imported
    Then the FIT import is refused with "not-a-workout"

  Scenario: A running workout is refused as not cycling
    When the FIT workout file "running.fit" is imported
    Then the FIT import is refused with "not-cycling"

  Scenario: A file with a broken CRC is refused
    When the FIT workout file "bad-crc.fit" is imported
    Then the FIT import is refused with "bad-crc"

  Scenario: A truncated file is refused
    When the FIT workout file "truncated.fit" is imported
    Then the FIT import is refused with "truncated"
