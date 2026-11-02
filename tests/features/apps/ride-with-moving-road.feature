@phase-7 @e2e @ui
Feature: The road moves smoothly while I ride
  In the real app, the landscape renders on its own clock from interpolated physics
  states; the HUD keeps its numbers.

  Scenario: Riding with a simulated trainer at 60 FPS
    Given the plugin directories "plugins, tests/fixtures/plugins/simulated-trainer"
    And the plugin "transport-ble-tauri" is disabled
    And the plugin "transport-ble-noble" is disabled
    And the app renders with a 60 FPS frame source
    When I start the ridrs app with these options
    And I press "Start ride"
    Then eventually the landscape presents a distance of more than 1.00 m
    And the landscape's distance never decreases over 30 frames
    And between 50 and 62 frames are rendered per second
    And the virtual-speed widget keeps rising
    When I press "Finish ride"
    Then the "main" screen is shown
    And no frames are rendered
    When I close the ridrs app
    Then the app reported no lifecycle problems
