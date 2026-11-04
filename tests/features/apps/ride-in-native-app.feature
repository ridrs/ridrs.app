@phase-3 @e2e @ui
Feature: Start a ride and see power and cadence
  The native app's composition root puts all real plugins, the in-process UI bridge and the
  shell into one process - here with plugin folders instead of the bundle and a headless DOM
  instead of the WebView.

  Scenario: Riding with a simulated trainer
    Given the plugin directories "plugins, tests/fixtures/plugins/simulated-trainer"
    And the plugin "bridge-connector-tauri" is disabled
    And the plugin "transport-ble-tauri" is disabled
    And the plugin "transport-ble-noble" is disabled
    When I start the ridrs app with these options
    And I press "Start ride"
    Then the power widget shows "220" "W"
    And the cadence widget shows "92" "rpm"
    When I press "Finish ride"
    Then the "main" screen is shown
    When I close the ridrs app
    Then the app reported no lifecycle problems

  Scenario: Riding without any trainer shows honest dashes
    Given the plugin directories "plugins"
    And the plugin "bridge-connector-tauri" is disabled
    And the plugin "transport-ble-noble" is disabled
    When I start the ridrs app with these options
    And I press "Start ride"
    Then the power widget is unavailable without a reason
    And the cadence widget is unavailable without a reason
    When I close the ridrs app
    Then the app reported no lifecycle problems

  Scenario: The screen stays awake only while a ride runs
    Given the plugin directories "plugins"
    And the plugin "bridge-connector-tauri" is disabled
    And the plugin "transport-ble-noble" is disabled
    When I start the ridrs app with these options
    Then the app lets the screen sleep
    When I press "Start ride"
    Then the app keeps the screen awake
    When I press "Finish ride"
    Then the app lets the screen sleep
