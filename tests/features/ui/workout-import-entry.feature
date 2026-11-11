@ui @training
Feature: The Training area opens the workout import
  The library of the Training area offers "Import workouts" when the import plugin is there: it
  opens the screen `workout-import` in a dialog over the page (ADR 0071). Off the ride path a
  pointer is enough (ADR 0080).

  Scenario: "Import workouts" opens the import over the Training area
    Given the ridrs plugins "activity-session, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-settings, ui-area-training, library-ridrs, ui-workout-import, profile-local" together with a test device plugin "test-device"
    And the host has started
    And the ridrs UI is shown
    When I press "Training"
    And I press "Import workouts"
    Then the "workout-import" screen is shown

  Scenario: Without the import plugin the library offers no import
    Given the ridrs plugins "activity-session, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-settings, ui-area-training, library-ridrs, profile-local" together with a test device plugin "test-device"
    And the host has started
    And the ridrs UI is shown
    When I press "Training"
    Then the Training area has no button "Import workouts"
