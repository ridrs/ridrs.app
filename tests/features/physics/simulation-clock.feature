@phase-5 @fake-timers
Feature: The fixed simulation step
  While a ride runs, the physics advances in fixed 10 ms steps - independent of how
  often sensors deliver and of when the host gets to run it.

  Background:
    Given the ridrs physics plugins together with a test device plugin "test-device" and a probe plugin "test-ui"
    And the host has started

  Scenario: Without a ride there is no simulation
    When 5 s pass
    Then no physics state was published

  Scenario: A ride starts at standstill
    When "test-ui" publishes "activity.start-requested"
    Then the latest "physics.state" event is step 0 at "+0 ms" with a speed of 0.00 km/h and a distance of 0.00 m

  Scenario: One hundred steps per second, one published state every 250 ms
    Given "test-ui" published "activity.start-requested"
    When 1 s passes
    Then physics states were published at "+0 ms, +250 ms, +500 ms, +750 ms, +1000 ms"
    And the state at "+1000 ms" is step 100

  Scenario: The step does not depend on the sensor rate
    Given "test-ui" published "activity.start-requested"
    When "test-device" delivers only power 200 W every 1 s for 1 second
    Then the state at "+1000 ms" is step 100

  Scenario: A late host catches up without losing steps
    Given "test-ui" published "activity.start-requested"
    And "test-device" delivered only power 200 W every 0.25 s for 1 second
    When the host is blocked for 500 ms
    Then physics states were published at "+1250 ms, +1500 ms" after "+1000 ms"
    And the state at "+1500 ms" is step 150
    And the virtual speed at "+1500 ms" is 8.72 km/h

  Scenario: Finishing the ride stops the simulation
    Given "test-ui" published "activity.start-requested"
    And "test-device" delivered only power 200 W every 0.25 s for 5 seconds
    When "test-ui" publishes "activity.finish-requested"
    And 5 s pass
    Then the latest "physics.state" event is step 500 at "+5000 ms" with a speed of 16.32 km/h and a distance of 14.79 m

  Scenario: A new ride starts again at standstill
    Given "test-ui" published "activity.start-requested"
    And "test-device" delivered only power 200 W every 0.25 s for 5 seconds
    And "test-ui" published "activity.finish-requested"
    When "test-ui" publishes "activity.start-requested"
    Then the latest "physics.state" event is step 0 at "+5000 ms" with a speed of 0.00 km/h and a distance of 0.00 m
    And its session differs from the one of the finished ride

  Scenario: Stopping the host leaves no simulation timer
    Given "test-ui" published "activity.start-requested"
    When the host stops
    Then no timers are pending
