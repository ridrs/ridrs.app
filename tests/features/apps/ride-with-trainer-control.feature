@phase-8 @e2e @ui
Feature: Ride with trainer control in the app
  The real app composition with a simulated trainer that has a control point and a
  simulated Zwift Ride: the demo landscape drives the trainer, the controller shifts, and
  the rider sets an ERG target with the keyboard alone.

  Scenario: Climb, shift and ERG with a simulated trainer and controller
    Given the plugin directories "plugins, tests/fixtures/plugins/simulated-trainer"
    And the plugin "bridge-connector-tauri" is disabled
    And the plugin "transport-ble-tauri" is disabled
    And the plugin "transport-ble-noble" is disabled
    When I start the ridrs app with these options
    And I press "Start ride"
    Then eventually the simulated trainer received a simulation command
    And eventually the virtual gear widget shows "12"
    When the simulated controller presses "shift-up-right"
    Then eventually the virtual gear widget shows "13"
    When I move the focus to "ERG"
    And I press Enter
    And I press the arrow key "Up"
    And I press the arrow key "Up"
    Then the ERG button is on at "160 W"
    And eventually the simulated trainer received a target power of 160 W
    And eventually the power widget shows "160" "W"
    When I press Back
    Then the ERG button is off
    And eventually the simulated trainer received a simulation command after the target power
    When I close the ridrs app
    Then the app reported no lifecycle problems
