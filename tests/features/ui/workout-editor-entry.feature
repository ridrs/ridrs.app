@ui @training
Feature: The Training area opens the editor for a new workout
  The library of the Training area offers "New workout": the editor (`ui.workout-editor`) takes the
  place of the area's content, like the details; Cancel gives the area back with the focus on
  "New workout". Off the ride path a pointer is enough (ADR 0080).

  Scenario: "New workout" opens the editor, Cancel closes it
    Given the ridrs plugins "activity-session, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-settings, ui-area-training, library-ridrs, ui-workout-chart, ui-workout-editor, profile-local" together with a test device plugin "test-device"
    And the host has started
    And the ridrs UI is shown
    When I press "Training"
    And I press "New workout"
    Then the workout editor shows the heading "New workout"
    When I press "Cancel"
    Then the focus is on "New workout"

  Scenario: Without the editor plugin nothing opens
    Given the ridrs plugins "activity-session, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-settings, ui-area-training, library-ridrs, profile-local" together with a test device plugin "test-device"
    And the host has started
    And the ridrs UI is shown
    When I press "Training"
    And I press "New workout"
    Then the focus is on "New workout"
