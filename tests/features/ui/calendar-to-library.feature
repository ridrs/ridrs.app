@ui @training
Feature: A planned workout is added to the rider's own workouts by dragging it onto them
  A planned workout of the calendar can be kept as one of the rider's own workouts: while it is
  dragged, the workouts below the calendar say that it can be dropped there, and a drop copies it
  with its steps into the library of ridrs on this device (`training.library.save`, provider
  `ridrs`). The pointer shows a copy there. What has no steps cannot become a workout: a rest
  day, a note, an outdoor ride, a planned workout its calendar keeps without steps. Such an entry
  is not taken, and the workouts say why while it is dragged over them; so is a workout planned
  from the rider's workouts, which is one of them already. A workout of a library is in a library
  already: dragging one over the workouts is not taken either.

  Here intervals.icu, the browser and the secret store are simulated. It is Wednesday 4 November
  2026.

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-settings, ui-area-training, library-ridrs, ui-area-me, profile-local, planner-intervals-icu, ui-training-plan" together with the simulated intervals.icu
    And a test device plugin "test-device"
    And intervals.icu knows the athlete "Alex Rider" with an FTP of 250 W and a weight of 72 kg
    And the local time is "2026-11-04 08:00"
    And the main screen is 1400 px wide

  Scenario: A structured workout of intervals.icu is copied into the rider's workouts
    Given intervals.icu plans "Over-Unders" on "2026-11-05" with the steps:
      | step     | duration | power  |
      | warmup   | 10m      | 50-75% |
      | repeat   | 3x       |        |
      | -        | 4m       | 95%    |
      | -        | 2m       | 105%   |
      | cooldown | 5m       | 60-40% |
    And the secret store holds a token for intervals.icu
    And the host has started
    And the ridrs UI is shown
    When I press "Training"
    And I start dragging the planned workout "Over-Unders"
    Then the workouts say "Drop here to add “Over-Unders” to your workouts"
    When I drag the planned workout "Over-Unders" onto the workouts
    Then the workouts took the drop as a copy
    And the section "Workouts" shows the workout "Over-Unders"
    And the ridrs library holds "Over-Unders" with the steps planned in intervals.icu
    And the page says "“Over-Unders” is now one of your workouts."
    And the calendar day "Thursday" lists "Over-Unders"

  Scenario: A planned workout without steps is not taken, and the workouts say why
    Given intervals.icu plans:
      | date       | type | name         | duration | load |
      | 2026-11-05 | Ride | Threshold 20 | 1h       | 80   |
    And the secret store holds a token for intervals.icu
    And the host has started
    And the ridrs UI is shown
    When I press "Training"
    And I drag the planned workout "Threshold 20" over the workouts
    Then the workouts refused the drop
    And the workouts say "“Threshold 20” has no steps: only a structured workout can become one of your workouts."
    When I drag the planned workout "Threshold 20" onto the workouts
    Then the workouts refused the drop
    And the section "Workouts" shows no workout "Threshold 20"

  Scenario: A rest day, a note or an outdoor ride is not taken
    Given the host has started
    And the ridrs UI is shown
    When I press "Training"
    And I drag the planned workout "Outdoor ride" over the workouts
    Then the workouts refused the drop
    And the workouts say "An outdoor ride has no steps: only a structured workout can become one of your workouts."
    When I drag the planned workout "Outdoor ride" onto the workouts
    Then the workouts refused the drop
    And the section "Workouts" shows no workout "Outdoor ride"

  Scenario: A workout planned from the rider's workouts is one of them already
    Given the host has started
    And the ridrs UI is shown
    When I press "Training"
    And I drag the workout "Sweet Spot 3×12" onto "Friday"
    And I drag the planned workout "Sweet Spot 3×12" over the workouts
    Then the workouts refused the drop
    And the workouts say "“Sweet Spot 3×12” is one of your workouts already."

  Scenario: A workout of a library is not taken by the workouts
    Given the host has started
    And the ridrs UI is shown
    When I press "Training"
    And I start dragging the workout "Sweet Spot 3×12"
    Then the workouts say nothing about a drop
    When I drag the workout "Sweet Spot 3×12" over the workouts
    Then the workouts refused the drop

  Scenario: The workouts speak German while a planned workout is dragged
    Given intervals.icu plans "Over-Unders" on "2026-11-05" with the steps:
      | step     | duration | power  |
      | warmup   | 10m      | 50-75% |
      | cooldown | 5m       | 60-40% |
    And the secret store holds a token for intervals.icu
    And the host has started
    And the ridrs UI is shown
    When I press "Settings"
    And I press "Deutsch"
    And I press "Schließen"
    And I press "Training"
    And I start dragging the planned workout "Over-Unders"
    Then the workouts say "Hier ablegen, um „Over-Unders“ zu deinen Workouts hinzuzufügen"
    When I drag the planned workout "Over-Unders" onto the workouts
    Then the page says "„Over-Unders“ ist jetzt eines deiner Workouts."
