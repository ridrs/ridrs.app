@phase-8 @fake-timers
Feature: The physics computes what the trainer should feel
  Two loads for the same step, as FTMS simulation parameters: the load of the virtual bike
  without the virtual gear, and the same load with it. The physics knows no trainer.

  Background:
    Given the ridrs physics plugins together with a test device plugin "test-device" and a probe plugin "test-ui"
    And the plugin "physics-trainer-load" is loaded as well

  Scenario: The load follows the road
    Given a mock world "test-road" feeds the terrain ahead with a constant gradient of 5 % when the ride starts
    And the host has started
    And "test-ui" published "activity.start-requested"
    When "test-device" delivers only power 200 W every 0.25 s for 10 seconds
    Then the trainer load at "+10 s" has the gradient 0.05, the Crr 0.004 and the wind resistance coefficient 0.392
    And the trainer load with virtual gear at "+10 s" equals the trainer load
    And the trainer load at "+10 s" names no virtual gear

  Scenario: Gravel raises the rolling resistance
    Given a mock world "test-road" feeds flat "gravel" ahead when the ride starts
    And the host has started
    And "test-ui" published "activity.start-requested"
    When "test-device" delivers only power 200 W every 0.25 s for 10 seconds
    Then the trainer load at "+10 s" has the gradient 0, the Crr 0.008 and the wind resistance coefficient 0.392

  Scenario: Every step's sample carries the load of its step
    Given a mock world "test-road" feeds the terrain ahead, flat for the first 20 m and then climbing at 5 %, when the ride starts
    And the host has started
    And "test-ui" published "activity.start-requested"
    When "test-device" delivers only power 200 W every 0.25 s for 10 seconds
    Then every sample of "physics.state-batch" has a trainer load with the gradient of its step

  # The same numbers as the Phase 6 ride without "physics-trainer-load".
  Scenario: The trainer load never changes the motion
    Given a mock world "test-road" feeds the terrain ahead with a constant gradient of 5 % when the ride starts
    And the host has started
    And "test-ui" published "activity.start-requested"
    When "test-device" delivers only power 200 W every 0.25 s for 60 seconds
    Then the virtual speed at "+60 s" is 14.90 km/h

  Scenario: The physics stays a reader
    Given the host has started
    Then the plugin "physics-trainer-load" subscribes to no event
    And the manifest of "physics-trainer-load" requires exactly "physics.bicycle, physics.rider, physics.environment"
