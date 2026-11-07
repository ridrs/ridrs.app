@phase-9 @e2e @ui
Feature: Continue an interrupted ride in the app
  The app stops in the middle of a ride. At the next start the main screen offers to continue it
  (ADR 0057); the ride goes on paused, with its session, until the rider resumes it, and is saved
  as one ride that replays without differences.

  Background:
    Given the plugin directories "plugins, tests/fixtures/plugins/simulated-trainer"
    And the plugin "bridge-connector-tauri" is disabled
    And the plugin "transport-ble-tauri" is disabled
    And the plugin "transport-ble-noble" is disabled
    And the app stores its files in a fresh temporary data directory
    And I start the ridrs app with these options
    And I press "Start ride"
    And the power widget shows "220" "W"
    And 3 seconds pass in real time
    And I close the ridrs app

  Scenario: Continuing the interrupted ride
    When I start the ridrs app with these options
    Then the "main" screen is shown
    And the focus is on "Continue ride"
    When I press "Continue ride"
    Then the "activity" screen is shown
    And the page shows "Paused"
    When I press "Resume"
    Then the power widget shows "220" "W"
    When 2 seconds pass in real time
    And I press "Finish ride"
    Then the "debriefing" screen is shown
    And the debriefing offers "Save" and "Delete"
    When I press "Save"
    Then the "main" screen is shown
    And eventually the "ride-saved" panel shows a recording file and a FIT file
    When I run "ridrs-headless recording replay" on the saved recording
    Then the command exits with 0 and reports "identical"
    When I close the ridrs app
    Then the app reported no lifecycle problems

  Scenario: Finishing the interrupted ride
    When I start the ridrs app with these options
    And I press "Finish ride"
    Then eventually the "ride-saved" panel shows a recording file and a FIT file
    And the page offers no "Continue ride" button
    When I close the ridrs app
    Then the app reported no lifecycle problems
