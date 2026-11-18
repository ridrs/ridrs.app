@ui
Feature: The rider takes a screenshot of the ride
  During a ride the activity screen offers Screenshot, a round button with a camera next to the
  ERG button, between it and Finish ride (`activity/control`). It asks the app for a screenshot
  of the ride (`ride.screenshot`, an app command beside the bus: nothing is recorded) and says
  briefly whether it was saved. It works with the arrow keys and Enter (AGENTS.md rule 12).

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-tile-ride-start, ui-activity-screen, ui-widget-target-power, control-erg, ui-ride-screenshot" together with a test device plugin "test-device"
    And a stand-in takes the ride's screenshots
    And the host has started
    And the ridrs UI is shown
    And I press "Start ride"

  Scenario: Screenshot is a round button between ERG and Finish ride
    Then the ride's buttons "Pause, ERG, Screenshot, Finish ride" are round and side by side at the bottom right
    And the ERG button comes before the Screenshot button

  Scenario: Screenshot asks for a screenshot of this ride and says it was saved
    When I press "Screenshot"
    Then a screenshot of the ride was asked for once, with the ride's start
    And the page shows "Screenshot saved"

  Scenario: Every press asks for another screenshot
    When I press "Screenshot"
    And I press "Screenshot"
    Then a screenshot of the ride was asked for 2 times

  Scenario: A screenshot that could not be taken says so, and the ride goes on
    Given the stand-in cannot take screenshots
    When I press "Screenshot"
    Then the page shows "Screenshot failed"
    And the "activity" screen is shown
    And the page offers a "Pause" button

  Scenario: Screenshot is reached with the arrow keys and taken with Enter
    Given I move the focus to "ERG"
    When I press the arrow key "Right"
    Then the focus is on "Screenshot"
    When I press Enter
    Then a screenshot of the ride was asked for once, with the ride's start
    And the focus is on "Screenshot"
