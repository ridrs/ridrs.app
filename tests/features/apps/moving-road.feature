@phase-5 @e2e @ui
Feature: The road moves with the virtual speed
  The lane markings of the flat landscape pass by at the virtual rider's speed, so the
  ride feels like moving forward. Without speed they stand still.

  Scenario: The lane markings move while riding
    Given the plugin directories "plugins, tests/fixtures/plugins/simulated-trainer"
    And the plugin "bridge-connector-tauri" is disabled
    And the plugin "transport-ble-tauri" is disabled
    And the plugin "transport-ble-noble" is disabled
    When I start the ridrs app with these options
    And I press "Start ride"
    Then eventually the virtual-speed widget shows more than "10.0" "km/h"
    And the lane markings move
    When I close the ridrs app
    Then the app reported no lifecycle problems

  Scenario: Without a trainer the lane markings stand still
    Given the plugin directories "plugins"
    And the plugin "bridge-connector-tauri" is disabled
    And the plugin "transport-ble-noble" is disabled
    When I start the ridrs app with these options
    And I press "Start ride"
    Then the virtual-speed widget shows "0.0" "km/h"
    And the lane markings stand still
    When I close the ridrs app
    Then the app reported no lifecycle problems
