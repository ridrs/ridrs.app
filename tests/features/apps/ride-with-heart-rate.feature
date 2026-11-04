@phase-4 @e2e @ui
Feature: Ride with a trainer and a heart-rate sensor
  Two sources with different rates in the real app: all values are shown together,
  silence is detected per source, and the ratio uses time-aligned values.

  Scenario: Riding with a simulated trainer and heart-rate band
    Given the plugin directories "plugins, tests/fixtures/plugins/simulated-ride"
    And the plugin "bridge-connector-tauri" is disabled
    And the plugin "transport-ble-tauri" is disabled
    And the plugin "transport-ble-noble" is disabled
    When I start the ridrs app with these options
    And I press "Start ride"
    Then the power widget shows "220" "W"
    And the cadence widget shows "92" "rpm"
    And the heart-rate widget shows "145" "bpm"
    And eventually the power-heart-rate-ratio widget shows "1.52" "W/bpm"
    When the heart-rate band "SIM HRM" stops sending
    Then eventually the heart-rate widget is unavailable with the reason "no signal"
    And the power-heart-rate-ratio widget is unavailable with the reason "no signal"
    And the power widget shows "220" "W"
    When I close the ridrs app
    Then the app reported no lifecycle problems

  Scenario: Without a trainer, heart rate is still shown
    Given the plugin directories "plugins, tests/fixtures/plugins/simulated-ride"
    And the plugin "bridge-connector-tauri" is disabled
    And the plugin "transport-ble-tauri" is disabled
    And the plugin "transport-ble-noble" is disabled
    And the simulated trainer is switched off
    When I start the ridrs app with these options
    And I press "Start ride"
    Then the heart-rate widget shows "145" "bpm"
    And the power widget is unavailable without a reason
    And the power-heart-rate-ratio widget is unavailable with the reason "no source"
    When I close the ridrs app
    Then the app reported no lifecycle problems

  Scenario: The HUD shows the widgets in contribution order
    Given the plugin directories "plugins, tests/fixtures/plugins/simulated-ride"
    And the plugin "bridge-connector-tauri" is disabled
    And the plugin "transport-ble-tauri" is disabled
    And the plugin "transport-ble-noble" is disabled
    When I start the ridrs app with these options
    And I press "Start ride"
    Then the slot "hud/widget" contains the contributions "ui-widget-power/power, ui-widget-cadence/cadence, ui-widget-heart-rate/heart-rate, ui-widget-power-heart-rate-ratio/power-heart-rate-ratio, ui-widget-virtual-speed/virtual-speed, ui-widget-virtual-distance/virtual-distance, ui-widget-gradient/gradient" in this order
    When I close the ridrs app
    Then the app reported no lifecycle problems
