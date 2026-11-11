@ui @training
Feature: The details of a workout open its export
  The details of a library workout offer "Export": the export (`ui.workout-export`) takes the
  place of the details, like the editor, and its Back gives the details back. Off the ride path a
  pointer is enough (ADR 0080).

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-settings, ui-area-training, library-ridrs, profile-local, ui-workout-chart, ui-workout-details, ui-workout-export" together with a test device plugin "test-device"
    And the host has started
    And the ridrs UI is shown

  Scenario: "Export" in the details offers the formats, Back returns to the details
    When I press "Training"
    And I move the focus to "Sweet Spot 3×12"
    And I press Enter
    Then the details of the workout show the name "Sweet Spot 3×12"
    When I press "Export"
    Then the workout export offers the formats "ZWO (Zwift), FIT (Garmin), ERG, MRC, TCX (Garmin), intervals.icu text"
    When I press "Back"
    Then the details of the workout show the name "Sweet Spot 3×12"
