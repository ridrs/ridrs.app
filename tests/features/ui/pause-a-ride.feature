@ui
Feature: The rider pauses and resumes a ride on the activity screen
  While a ride runs the activity screen offers Pause next to Finish ride; a paused ride says so
  and offers Resume (ADR 0056). Both work with the arrow keys and Enter (AGENTS.md rule 12).
  They are round buttons with an icon, side by side at the top left below the window's own
  buttons, drawn like the global actions of the main screen. They lie over the HUD, apart from it,
  so the HUD has the bottom of the screen to itself.

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

  Scenario: Pause and Finish ride are round buttons at the top left
    Then the ride's buttons "Pause, Finish ride" are round and side by side at the top left
    And the screen leaves the bottom of the HUD to the HUD

  Scenario: Resume takes the place of Pause at the top left
    When I press "Pause"
    Then the ride's buttons "Resume, Finish ride" are round and side by side at the top left
