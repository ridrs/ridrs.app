@ui
Feature: The rider pauses and resumes a ride on the activity screen
  While a ride runs the activity screen offers Pause next to Finish ride; a paused ride says so
  and offers Resume (ADR 0056). Both work with the arrow keys and Enter (AGENTS.md rule 12).

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-tile-ride-start, ui-activity-screen" together with a test device plugin "test-device"
    And the host has started
    And the ridrs UI is shown
    And I press "Start ride"

  Scenario: Pausing keeps the activity screen and offers Resume
    When I press "Pause"
    Then the "activity" screen is shown
    And the page shows "Paused"
    And the page offers a "Resume" button
    And the page offers no "Pause" button

  Scenario: Resuming goes on with the ride
    Given I press "Pause"
    When I press "Resume"
    Then the "activity" screen is shown
    And the page shows no "Paused"
    And the page offers a "Pause" button

  Scenario: A paused ride can be finished
    Given I press "Pause"
    When I press "Finish ride"
    Then the "main" screen is shown

  Scenario: Pause is reached with the arrow keys
    When I press the arrow key "Down"
    Then the focus is on "Pause"
    When I press Enter
    Then the page offers a "Resume" button
