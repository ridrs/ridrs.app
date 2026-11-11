Feature: Import of intervals.icu workout text
  The workout syntax of the intervals.icu workout builder, pasted from a description, is imported
  without conversion: percentages stay percentages, watts stay watts, zones stay zones.

  Scenario: Sections, a repeat, a ramp and cadence
    Given a workout text file "main.intervals.txt":
      """
      Warmup
      - 10m ramp 50%-75% 90rpm

      Main Set 3x
      - 4m 100% 95-100rpm
      - Recover 2m 55%

      Cooldown
      - 5m 200w
      """
    When the workout text file is imported
    Then the import succeeds with 1 workout
    And in the imported workout, step "1" lasts 600 seconds
    And in the imported workout, step "1" ramps from 50 to 75 percent-ftp
    And in the imported workout, step "1" also targets 90 rpm
    And in the imported workout, step "2" is a repeat of 3 times
    And in the imported workout, step "2.1" holds 100 percent-ftp
    And in the imported workout, step "2.1" also targets 95 to 100 rpm
    And in the imported workout, step "2.2" has the name "Recover"
    And in the imported workout, step "2.2" lasts 120 seconds
    And in the imported workout, step "3" holds 200 watts
    And the intervals extensions of the workout have "lines[0].text" equal to "Warmup"

  Scenario: Zones and heart rate targets keep their unit
    Given a workout text file "zones.txt":
      """
      - 20m Z2
      - 10m Z3 HR
      - 5m 80% LTHR
      - 5m 70% HR
      - 5m 140bpm
      - 5m 95-105%
      """
    When the workout text file is imported
    Then in the imported workout, step "1" holds 2 power-zone
    And in the imported workout, step "2" holds 3 hr-zone
    And in the imported workout, step "3" holds 80 percent-lthr
    And in the imported workout, step "4" holds 70 percent-max-hr
    And in the imported workout, step "5" holds 140 bpm
    And in the imported workout, step "6" holds 95 to 105 percent-ftp

  Scenario: Freeride, maxeffort and distance
    Given a workout text file "free.txt":
      """
      - 20m freeride
      - 30s maxeffort
      - 5km 70%
      """
    When the workout text file is imported
    Then in the imported workout, step "1" is free riding
    And in the imported workout, step "2" is a max effort
    And in the imported workout, step "3" lasts 5000 meters

  Scenario: Timed text prompts become cues
    Given a workout text file "prompts.txt":
      """
      - Settle in 30^Push now <!> 10m 75%
      """
    When the workout text file is imported
    Then in the imported workout, step "1" has the cue "Settle in" at 0 seconds
    And in the imported workout, step "1" has the cue "Push now" at 30 seconds

  Scenario: A pace target is refused as not cycling
    Given a workout text file "run.txt":
      """
      - 10m 80% Pace
      """
    When the workout text file is imported
    Then the import is refused with the code "not-cycling"

  Scenario: Text without any step is refused
    Given a workout text file "nothing.txt":
      """
      Just some words
      and no steps at all
      """
    When the workout text file is imported
    Then the import is refused with the code "no-steps"
    And the import has a reason
