@ui @training
Feature: The details of a workout
  The details show one workout of any provider's library, or a planned entry of a calendar
  (structured-workouts.md, sections 5.1, 6 and 7): its name, author and licence, its description,
  the numbers ridrs derives (duration, TSS, IF, work; estimated ones marked), the time per zone with
  the zones and the FTP of the chosen athlete profile, the chart (`ui.workout-chart`, variant
  `full`) and the list of its steps, in sync with the chart. Targets are shown in their own unit,
  with watts beside % when there is an FTP; heart rate, distance, bound and lap-button steps are
  shown and marked (F5). The details are on the ride path: arrows, Enter and Back alone (ADR 0080).

  Here a fixture host lists the fixture library and calendar and opens the details of an entry
  with Enter; a fixture chart stands in for `ui-workout-chart`: it shows what it was given, and
  each of its steps reports `step-focused` when it takes the focus, as the `full` chart does.

  Background:
    Given the ridrs plugins "ui-settings, profile-local, ui-workout-details" with the workout details fixtures
    And the athlete profile on this device holds an FTP of 250 W and a weight of 72 kg

  Scenario: The details of a library workout show what it is and what it asks
    Given the fixture chart of workouts is installed
    And the host has started
    And the ridrs UI is shown
    When I move the focus to "Sweet Spot 3x12"
    And I press Enter
    Then the details of the workout show the name "Sweet Spot 3x12"
    And the details of the workout show "by ridrs · CC-BY-SA-4.0"
    And the details of the workout show "Three blocks of twelve minutes just below the threshold."
    And the details of the workout show the numbers:
      | Duration | 1 h 3 min |
      | TSS      | 69        |
      | IF       | 0.81      |
      | Work     | 720 kJ    |
    And the details of the workout show the time per zone:
      | Z1 Active Recovery   | 16 min 30 s |
      | Z2 Endurance         | 10 min 30 s |
      | Z3 Tempo             | 36 min      |
      | Z4 Threshold         | –           |
      | Z5 VO2 Max           | –           |
      | Z6 Anaerobic Capacity  | –         |
      | Z7 Neuromuscular Power | –         |
    And the workout chart draws "Sweet Spot 3x12" in the variant "full" with an FTP of 250 W

  Scenario: The arrows step through the steps and the chart follows
    Given the fixture chart of workouts is installed
    And the host has started
    And the ridrs UI is shown
    When I move the focus to "Sweet Spot 3x12"
    And I press Enter
    Then the details of the workout list the steps:
      | step       | duration | target                            | mark |
      | Warm-up    | 10 min   | 50 → 75 % FTP · 125 → 188 W       |      |
      | 3×         |          |                                   |      |
      | Sweet spot | 12 min   | 90 % FTP · 225 W · 85–95 rpm      |      |
      | Recovery   | 4 min    | 55 % FTP · 138 W                  |      |
      | Cool-down  | 5 min    | 65 → 45 % FTP · 163 → 113 W       |      |
    When I move the focus to the first step of the details of the workout
    Then the focused step of the details of the workout is "Warm-up"
    And the workout chart shows the step "1" as selected
    When I press the arrow key "Down"
    Then the focused step of the details of the workout is "Sweet spot"
    And the workout chart shows the step "2.1" as selected
    When I press the arrow key "Down"
    Then the focused step of the details of the workout is "Recovery"
    And the workout chart shows the step "2.2" as selected
    And the selected step of the details of the workout is "Recovery"

  Scenario: A step focused in the chart selects its row
    Given the fixture chart of workouts is installed
    And the host has started
    And the ridrs UI is shown
    When I move the focus to "Sweet Spot 3x12"
    And I press Enter
    And the workout chart focuses the step "2.2"
    Then the selected step of the details of the workout is "Recovery"
    And the workout chart shows the step "2.2" as selected

  Scenario: Heart rate, distance, bound and lap-button steps are shown and marked
    Given the host has started
    And the ridrs UI is shown
    When I move the focus to "Heart Rate Endurance"
    And I press Enter
    Then the details of the workout show the name "Heart Rate Endurance"
    And the details of the workout list the steps:
      | step              | duration                        | target           | mark       |
      | Easy spin         | 10 min                          | 150 W            |            |
      | Steady heart rate | 20 min                          | 130–140 bpm      | Heart rate |
      | Five kilometres   | 5 km                            | 70 % FTP · 175 W | Distance   |
      | Until recovered   | until heart rate below 110 bpm  | Free ride        | Until      |
      | Free spin         | until the lap button            | Free ride        | Lap button |
    And the details of the workout show the numbers:
      | Duration | ≈ 50 min |
      | TSS      | ≈ 35     |
      | IF       | ≈ 0.64   |
      | Work     | ≈ 480 kJ |
    And the details of the workout show "Estimated: not every step goes by time and power."

  Scenario: Without the chart provider the details show a plain fallback
    Given the host has started
    And the ridrs UI is shown
    When I move the focus to "Sweet Spot 3x12"
    And I press Enter
    Then the details of the workout show the chart fallback "1 h 3 min · 69 TSS"
    And the details of the workout list 4 steps to focus

  Scenario: Back leaves the details
    Given the fixture chart of workouts is installed
    And the host has started
    And the ridrs UI is shown
    When I move the focus to "Sweet Spot 3x12"
    And I press Enter
    And I move the focus to the first step of the details of the workout
    And I press Back
    Then no details of a workout are shown
    And the focus is on "Sweet Spot 3x12"

  Scenario: The details of a planned entry take author and licence from its library workout
    Given the host has started
    And the ridrs UI is shown
    When I move the focus to "Sweet Spot 3x12 on 2026-11-12"
    And I press Enter
    Then the details of the workout show the name "Sweet Spot 3x12"
    And the details of the workout show "Planned for Thu 12 Nov"
    And the details of the workout show "by ridrs · CC-BY-SA-4.0"

  Scenario: The details speak German
    Given the rider speaks German
    And the host has started
    And the ridrs UI is shown
    When I move the focus to "Heart Rate Endurance"
    And I press Enter
    Then the details of the workout show the numbers:
      | Dauer  | ≈ 50 min |
      | TSS    | ≈ 35     |
      | IF     | ≈ 0,64   |
      | Arbeit | ≈ 480 kJ |
    And the details of the workout show the heading "Zeit pro Zone"
    And the details of the workout list the steps:
      | step              | duration                       | target           | mark        |
      | Easy spin         | 10 min                         | 150 W            |             |
      | Steady heart rate | 20 min                         | 130–140 bpm      | Herzfrequenz |
      | Five kilometres   | 5 km                           | 70 % FTP · 175 W | Distanz     |
      | Until recovered   | bis Herzfrequenz unter 110 bpm | Freie Fahrt      | Bis         |
      | Free spin         | bis zur Rundentaste            | Freie Fahrt      | Rundentaste |
