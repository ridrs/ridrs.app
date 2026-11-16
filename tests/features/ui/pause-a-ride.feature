@ui
Feature: The rider pauses and resumes a ride on the activity screen
  While a ride runs the activity screen offers Pause next to Finish ride; a paused ride says so
  and offers Resume (ADR 0056). Both work with the arrow keys and Enter (AGENTS.md rule 12).
  They are round buttons with an icon, side by side at the bottom right, drawn like the global
  actions of the main screen. They lie over the HUD; the screen keeps that corner free for them,
  and the rest of the bottom stays the HUD's.

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

  Scenario: Pause and Finish ride are round buttons at the bottom right
    Then the ride's buttons "Pause, Finish ride" are round and side by side at the bottom right
    And the screen keeps the bottom right corner of the HUD free for the ride's buttons
    And the screen leaves the rest of the bottom of the HUD to the HUD

  Scenario: Resume takes the place of Pause at the bottom right
    When I press "Pause"
    Then the ride's buttons "Resume, Finish ride" are round and side by side at the bottom right
