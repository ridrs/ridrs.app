@phase-10 @e2e @ui
Feature: The landscape shows the road the physics rides
  The landscape lives in the UI: it draws the road from its model, asphalt and gravel in
  different colours, and tells the host what it shows ahead. When it is mounted for a
  ride it publishes the window from 0 m, then a new one whenever less than half of the
  last one is left ahead of what it presents, and at standstill nothing.

  Scenario: When the ride starts one window from 0 m, at standstill nothing more
    Given the plugin directories "plugins, tests/fixtures/plugins/terrain-observer"
    And the plugin "bridge-connector-tauri" is disabled
    And the plugin "transport-ble-noble" is disabled
    When I start the ridrs app with these options
    And I press "Start ride"
    And I start a free ride in the briefing
    Then eventually the landscape observed 1 window, from 0 m with 21 samples 1 m apart
    And the landscape shows "asphalt" under the rider
    When 1 second passes in the app
    Then the landscape observed 1 window, from 0 m with 21 samples 1 m apart
    And "world-driver-ui" accepted every window the landscape observed
    When I close the ridrs app
    Then the app reported no lifecycle problems

  Scenario: While riding a new window goes out when less than half is left
    Given the plugin directories "plugins, tests/fixtures/plugins/simulated-trainer, tests/fixtures/plugins/terrain-observer"
    And the plugin "bridge-connector-tauri" is disabled
    And the plugin "transport-ble-tauri" is disabled
    And the plugin "transport-ble-noble" is disabled
    When I start the ridrs app with these options
    And I press "Start ride"
    And I start a free ride in the briefing
    Then eventually the landscape presents a distance of more than 25.00 m
    And every window of the ride went out with less than 10 m left of the one before, from the whole metre at or behind the odometer
    And "world-driver-ui" accepted every window the landscape observed
    And the app reported no "terrain-preview-rejected" diagnostic
    And the app reported no "terrain-preview-missing" diagnostic
    When I close the ridrs app
    Then the app reported no lifecycle problems
