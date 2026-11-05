@phase-5 @fake-timers
Feature: The simulation stands still while the ride is paused
  During a pause no step runs and no distance is covered; on resume the steps go on from the
  resume time with the speed the ride had (ADR 0056).

  Background:
    Given the ridrs physics plugins together with a test device plugin "test-device" and a probe plugin "test-ui"
    And the host has started
    And "test-ui" published "activity.start-requested"
    And "test-device" delivered only power 200 W every 0.25 s for 5 seconds

  Scenario: No step runs in a pause
    When "test-ui" publishes "activity.pause-requested"
    And 120 s pass
    Then the latest "physics.state" event is step 500 at "+5000 ms" with a speed of 16.32 km/h and a distance of 14.79 m

  Scenario: The steps go on from the resume time
    Given "test-ui" published "activity.pause-requested"
    And 120 s pass
    When "test-ui" publishes "activity.resume-requested"
    And 1 s passes
    Then physics states were published at "+125250 ms, +125500 ms, +125750 ms, +126000 ms" after "+5000 ms"
    And the state at "+126000 ms" is step 600

  Scenario: Finishing a paused ride computes no more steps
    Given "test-ui" published "activity.pause-requested"
    And 60 s pass
    When "test-ui" publishes "activity.finish-requested"
    Then the latest "physics.state" event is step 500 at "+5000 ms" with a speed of 16.32 km/h and a distance of 14.79 m
