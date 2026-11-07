@phase-9 @e2e @ui
Feature: Ride, save, export and replay
  In the real app, a ride is saved on finish. Its FIT file passes the official SDK's
  checks, and the headless CLI replays it without differences.

  Scenario: Saving a ride with a simulated trainer
    Given the plugin directories "plugins, tests/fixtures/plugins/simulated-trainer"
    And the plugin "bridge-connector-tauri" is disabled
    And the plugin "transport-ble-tauri" is disabled
    And the plugin "transport-ble-noble" is disabled
    And the app stores its files in a fresh temporary data directory
    When I start the ridrs app with these options
    And I press "Start ride"
    Then the power widget shows "220" "W"
    When 5 seconds pass in real time
    And I press "Finish ride"
    Then the "debriefing" screen is shown
    And the debriefing offers "Save" and "Delete"
    When I press "Save"
    Then the "main" screen is shown
    And eventually the "ride-saved" panel shows a recording file and a FIT file
    And the saved FIT file is valid according to the official FIT SDK
    And the saved FIT file has at least 4 records with a power of 220 W
    When I run "ridrs-headless recording replay" on the saved recording
    Then the command exits with 0 and reports "identical"
    When I run "ridrs-headless recording inspect" on the saved recording
    Then the command exits with 0 and lists the plugin "device-ftms-trainer"
    When I close the ridrs app
    Then the app reported no lifecycle problems
