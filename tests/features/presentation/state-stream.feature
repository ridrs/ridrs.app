@phase-7 @fake-timers
Feature: Every step reaches the presentation exactly once
  Besides the 4 Hz state, the engine streams every step's sample in batches of five.

  Background:
    Given the ridrs physics plugins together with a test device plugin "test-device" and a probe plugin "test-ui"
    And the host has started

  Scenario: A ride starts with a batch for step 0
    When "test-ui" publishes "activity.start-requested"
    Then the latest "physics.state-batch" event contains the steps "0"

  Scenario: One second of riding in batches of five
    Given "test-ui" published "activity.start-requested"
    When "test-device" delivers only power 200 W every 0.25 s for 1 second
    Then 21 physics state batches were published
    And together they contain every step from 0 to 100 exactly once, in order
    And the latest "physics.state-batch" event contains the steps "96, 97, 98, 99, 100"
    And physics states were published at "+0 ms, +250 ms, +500 ms, +750 ms, +1000 ms"

  Scenario: A late host still sends every step once, in the same batches
    Given "test-ui" published "activity.start-requested"
    And "test-device" delivered only power 200 W every 0.25 s for 1 second
    When the host is blocked for 500 ms
    Then 31 physics state batches were published
    And together they contain every step from 0 to 150 exactly once, in order

  Scenario: Finishing the ride sends the remaining steps
    Given "test-ui" published "activity.start-requested"
    And "test-device" delivered only power 200 W every 0.25 s for 1 second
    And 0.02 s pass
    When "test-ui" publishes "activity.finish-requested"
    Then the latest "physics.state-batch" event contains the steps "101, 102"

  Scenario: The samples are the states
    Given "test-ui" published "activity.start-requested"
    When "test-device" delivers only power 200 W every 0.25 s for 10 seconds
    Then the sample of step 1000 has a speed of 22.24 km/h and a distance of 41.94 m
