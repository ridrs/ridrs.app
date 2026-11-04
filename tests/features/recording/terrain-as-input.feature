@phase-10 @fake-timers
Feature: The terrain is recorded and replayed as an input
  The terrain enters the host as the input "world.terrain-preview". A recording keeps it
  like every other input, and the replay injects it at its recorded time - without the
  UI landscape or its driver. Every window of a ride arrives during the ride.

  Background:
    Given a simulated BLE environment with the Phase 2 trainer script "SIM KICKR" and a heart-rate band "SIM HRM"
    And the ridrs physics plugins, the device plugins, the metric plugins and "recording-session" together with a probe plugin "test-ui" and the memory storage

  Scenario: A ride on the demo landscape replays identically, with the terrain injected
    Given a mock world "test-world" feeds the demo landscape
    And the host has started
    And "test-ui" published "activity.start-requested" through the UI bridge
    And 30 s pass
    And "test-ui" published "activity.finish-requested" through the UI bridge
    When the recording is replayed
    Then the replay is identical
    And every recorded "world.terrain-preview" of the ride is not pre-roll
    And the replay injected every recorded "world.terrain-preview" as an input, and there was more than one

  Scenario: A window without a surface replays on asphalt
    Given a mock world "test-world" feeds the terrain ahead with a constant gradient of 0 % when the ride starts
    And the host has started
    And "test-ui" published "activity.start-requested" through the UI bridge
    And 30 s pass
    And "test-ui" published "activity.finish-requested" through the UI bridge
    When the recording is replayed
    Then the replay is identical
    And every recorded "physics.state" of the ride is on "asphalt"
