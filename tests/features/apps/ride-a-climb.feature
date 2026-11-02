@phase-6 @e2e @ui
Feature: Ride onto a climb
  In the real app, the rider sees the gradient and feels it in the speed.

  Scenario: The speed drops when the road climbs
    Given the plugin directories "plugins, tests/fixtures/plugins/simulated-trainer, tests/fixtures/plugins/short-climb"
    And the plugin "transport-ble-tauri" is disabled
    And the plugin "transport-ble-noble" is disabled
    And the plugin "physics-road" is disabled
    When I start the ridrs app with these options
    And I press "Start ride"
    Then the gradient widget shows "0.0" "%"
    And eventually the gradient widget shows "5.0" "%"
    And the virtual-speed widget keeps falling
    When I press "Finish ride"
    Then the "main" screen is shown
    When I close the ridrs app
    Then the app reported no lifecycle problems
