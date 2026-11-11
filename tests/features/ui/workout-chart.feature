@ui @training @workout
Feature: Workout charts in the Training area
  The Training area draws workouts with the workout chart (`ui.workout-chart`, ADR 0083): a
  workout card of a library shows a mini chart with its duration and load, a planned workout in
  the calendar a micro chart. Without the chart plugin, the card shows its plain facts. The
  catalogue of the library can be narrowed by duration (and by focus and source, once the
  libraries have them) with the arrow keys, Enter and Back alone (AGENTS.md rule 12): Back
  takes the filter off before it leaves the area.

  Here intervals.icu, the browser and the secret store are simulated. It is Wednesday 4 November
  2026, and the athlete's FTP is 250 W.

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-settings, ui-area-training, ui-area-me, profile-local, planner-intervals-icu, ui-training-plan, ui-workout-chart" together with the simulated intervals.icu
    And a test device plugin "test-device"
    And intervals.icu knows the athlete "Alex Rider" with an FTP of 250 W and a weight of 72 kg
    And intervals.icu has the library:
      | folder | name            | type | duration | load |
      | Base   | Sweet Spot 3x12 | Ride | 1h15m    | 78   |
      | -      | Tempo 40        | Ride | 40m      | 60   |
      | Base   | Endurance 90    | Ride | 1h30m    | 65   |
    And the library workout "Sweet Spot 3x12" of intervals.icu has the steps:
      | step     | duration | power  |
      | warmup   | 15m      | 50-75% |
      | repeat   | 3x       |        |
      | -        | 12m      | 90%    |
      | -        | 6m       | 55%    |
      | cooldown | 6m       | 60-40% |
    And the library workout "Tempo 40" of intervals.icu has the steps:
      | step | duration | power |
      | -    | 40m      | 80%   |
    And the local time is "2026-11-04 08:00"
    And the secret store holds a token for intervals.icu

  Scenario: A card shows a mini chart with its duration and load
    Given the host has started
    And the athlete profile of "intervals.icu" is in use
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Training"
    Then the library card "Sweet Spot 3x12" shows a mini chart saying "75 min · TSS 77"
    And the mini chart of "Sweet Spot 3x12" is described as "75 minutes, 3 intervals of 12 minutes at 90 %"
    And the library card "Sweet Spot 3x12" shows the facts "Base"

  Scenario: A card without steps shows no chart but its facts
    Given the host has started
    And the athlete profile of "intervals.icu" is in use
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Training"
    Then the library card "Endurance 90" shows the facts "Base · 90 min · 65 TSS"
    And the library card "Endurance 90" shows no chart

  Scenario: Without the chart plugin a card shows its plain facts
    Given the host has started
    And the athlete profile of "intervals.icu" is in use
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    And I press "Training"
    And the plugin "ui-workout-chart" is stopped
    Then the library card "Sweet Spot 3x12" shows the facts "Base · 75 min · 78 TSS"
    And the library card "Sweet Spot 3x12" shows no chart

  Scenario: A planned workout in the calendar shows a micro chart
    Given intervals.icu plans "Sweet Spot 3x12" on "2026-11-05" with the steps:
      | step     | duration | power  |
      | warmup   | 15m      | 50-75% |
      | repeat   | 3x       |        |
      | -        | 12m      | 90%    |
      | -        | 6m       | 55%    |
      | cooldown | 6m       | 60-40% |
    And the host has started
    And the athlete profile of "intervals.icu" is in use
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Training"
    Then the calendar day "Thursday" shows a micro chart for "Sweet Spot 3x12"

  Scenario: The charts are described in German
    Given the host has started
    And the athlete profile of "intervals.icu" is in use
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Training"
    And I press Back
    And I press "Settings"
    And I press "Deutsch"
    And I press "Schließen"
    And I press "Training"
    Then the mini chart of "Sweet Spot 3x12" is described as "75 Minuten, 3 Intervalle à 12 Minuten bei 90 %"

  Scenario: The catalogue is narrowed by duration with the arrow keys, Enter and Back
    Given the host has started
    And the athlete profile of "intervals.icu" is in use
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Training"
    Then the catalogue shows exactly "Tempo 40, Endurance 90, Sweet Spot 3x12"
    When I move the focus to "Duration: 30 to 60 min"
    And I press Enter
    Then the catalogue shows exactly "Tempo 40"
    When I move the focus to "Duration: 60 to 90 min"
    And I press Enter
    Then the catalogue shows exactly "Endurance 90, Sweet Spot 3x12"
    When I press Back
    Then the catalogue shows exactly "Tempo 40, Endurance 90, Sweet Spot 3x12"
    And the "training" screen is shown
