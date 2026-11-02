@phase-5 @fake-timers
Feature: Inputs aligned to the step time
  Every state asks the temporal data layer for the rider power at its own time.
  Estimates stay labelled, and missing power means no drive - never invented power.

  Background:
    Given the ridrs physics plugins together with a test device plugin "test-device" and a probe plugin "test-ui"
    And the probe plugin "test-reader" reads the temporal series "metric.power"
    And the host has started
    And "test-ui" published "activity.start-requested"

  Scenario: By default the wheel gets all of the rider's power
    When "test-device" delivers only power 200 W every 0.25 s for 2 seconds
    Then the rider power at "+2000 ms" is 200.00 W
    And the wheel power at "+2000 ms" is 200.00 W

  Scenario: A rising power is extrapolated with a decaying trend, then held, then stale
    When "test-device" delivers these power measurements:
      | value | at      |
      | 180   | +0 ms   |
      | 190   | +250 ms |
      | 200   | +500 ms |
      | 210   | +750 ms |
    And 2.25 s pass
    Then the rider power at "+1000 ms" is 220.00 W "extrapolated"
    And the rider power at "+1250 ms" is 226.32 W "extrapolated"
    And the rider power at "+1500 ms" is 228.65 W "extrapolated"
    And the rider power at "+2000 ms" is 228.65 W "held"
    And the rider power at "+3000 ms" is unavailable because of "stale"
    And the wheel power at "+3000 ms" is 0.00 W

  Scenario: Without a power source the rider stands still
    When 10 s pass
    Then the rider power at "+10000 ms" is unavailable because of "no-source"
    And the wheel power at "+10000 ms" is 0.00 W
    And the virtual speed at "+10000 ms" is 0.00 km/h
    And the virtual distance at "+10000 ms" is 0.00 m

  Scenario: A disconnected trainer means no drive
    Given "test-device" delivered only power 200 W every 0.25 s for 2 seconds
    When "test-device" reports device "trainer-1" as "reconnecting"
    And 1 s passes
    Then the rider power at "+3000 ms" is unavailable because of "disconnected"
    And the wheel power at "+3000 ms" is 0.00 W

  Scenario: Steps never write into the power series
    Given "test-device" delivered only power 200 W every 0.25 s for 1 second
    When 1 s passes
    Then the history of "metric.power" holds 5 measurements
