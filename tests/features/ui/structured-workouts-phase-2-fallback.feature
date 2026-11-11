@ui @training
Feature: Without the details plugin a workout card opens nothing
  The Training area shows the details of a workout through the UI capability
  `ui.workout-details` (ADR 0083). Where no plugin provides it, Enter on a card opens nothing:
  the card stays and keeps the focus.

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-settings, ui-area-training, library-ridrs, ui-area-me, profile-local, planner-intervals-icu, ui-training-plan, ui-workout-chart" together with the simulated intervals.icu
    And a test device plugin "test-device"
    And intervals.icu knows the athlete "Alex Rider" with an FTP of 250 W and a weight of 72 kg
    And the local time is "2026-11-04 08:00"
    And the secret store holds a token for intervals.icu
    And the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown

  Scenario: Enter on a card leaves the card where it is
    When I press "Training"
    And I move the focus to "Sweet Spot 3×12"
    And I press Enter
    Then no details of a workout are shown
    And the focus is on "Sweet Spot 3×12"
