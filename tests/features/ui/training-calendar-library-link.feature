@ui @training
Feature: A workout dropped into the calendar remembers its library workout
  A workout dropped from a library card into the calendar of ridrs on this device keeps a link to
  that library workout (structured-workouts.md, section 10). The planned workout handed to the
  rest of the app has its steps and the link, so Today draws its chart, and when the library
  workout is edited, Today follows. An entry from before the links has none and stays as it was.

  Here the planned workouts are those of ridrs on this device. It is Wednesday 4 November 2026.

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-settings, ui-area-training, library-ridrs, profile-local, ui-training-plan, ui-workout-import, ui-workout-editor, ui-workout-chart, ui-workout-details" with app files and a test device plugin "test-device"
    And the local time is "2026-11-04 08:00"
    And the athlete profile on this device holds an FTP of 250 W and a weight of 72 kg

  Scenario: A dropped workout carries its steps to Today
    Given the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Training"
    And I drag the workout "Sweet Spot 3×12" onto "Wednesday"
    And I press Back
    Then the next workout card shows:
      | day  | Today           |
      | name | Sweet Spot 3×12 |
    And the chart of the next workout draws the step "2.1" higher than the step "2.2"
    And the planned workout "Sweet Spot 3×12" of ridrs comes from the library "ridrs" workout "sweet-spot-3x12"

  Scenario: An edit of the library workout reaches Today
    Given the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Training"
    And I press "Import workouts"
    And I choose the file "sweet-spot-3x12.zwo"
    And I press "Import"
    And I press Back
    And I drag the workout "Sweet Spot 3x12" onto "Wednesday"
    And I open the details of the library workout "Sweet Spot 3x12"
    And I press "Edit" in the details of the workout
    And I set "power-value" of step 6 in the workout editor to "100"
    And I save the workout in the workout editor
    And I press Back
    And I press Back
    Then the chart of the next workout draws the step "6" higher than the step "4"

  Scenario: An entry from before the links still works
    Given the Training area kept a workout "Endurance 90" on Wednesday without a link to a library
    And the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    Then the next workout card shows:
      | day  | Today        |
      | name | Endurance 90 |
    And the next workout card has no chart
