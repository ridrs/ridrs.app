@phase-5 @e2e @ui
Feature: Pedal and see the virtual speed
  In the real app, the measured power moves a virtual rider: the HUD shows speed and
  distance next to power and cadence.

  Scenario: Riding with a simulated trainer
    Given the plugin directories "plugins, tests/fixtures/plugins/simulated-trainer"
    And the plugin "transport-ble-tauri" is disabled
    And the plugin "transport-ble-noble" is disabled
    When I start the ridrs app with these options
    And I press "Start ride"
    Then the power widget shows "220" "W"
    And eventually the virtual-speed widget shows more than "10.0" "km/h"
    And the virtual-speed widget keeps rising
    And eventually the virtual-distance widget shows at least "0.01" "km"
    When I press "Finish ride"
    Then the "main" screen is shown
    When I close the ridrs app
    Then the app reported no lifecycle problems

  Scenario: Without a trainer the rider stands still
    Given the plugin directories "plugins"
    And the plugin "transport-ble-noble" is disabled
    When I start the ridrs app with these options
    And I press "Start ride"
    Then the power widget is unavailable without a reason
    And the virtual-speed widget shows "0.0" "km/h"
    And the virtual-distance widget shows "0.00" "km"
    When I close the ridrs app
    Then the app reported no lifecycle problems

  Scenario: The HUD shows speed and distance after the metric widgets
    Given the plugin directories "plugins, tests/fixtures/plugins/simulated-trainer"
    And the plugin "transport-ble-tauri" is disabled
    And the plugin "transport-ble-noble" is disabled
    When I start the ridrs app with these options
    And I press "Start ride"
    Then the slot "hud/widget" contains the contributions "ui-widget-power/power, ui-widget-cadence/cadence, ui-widget-heart-rate/heart-rate, ui-widget-power-heart-rate-ratio/power-heart-rate-ratio, ui-widget-virtual-speed/virtual-speed, ui-widget-virtual-distance/virtual-distance, ui-widget-gradient/gradient" in this order
    When I close the ridrs app
    Then the app reported no lifecycle problems
