@phase-8 @fake-timers
Feature: Virtual gears from the Zwift Ride
  A press of a shift button shifts one of 24 virtual gears. The harder gear makes the same
  cadence feel harder on the trainer; the virtual speed still comes from the measured power.
  Any device that publishes controller buttons shifts.

  Background:
    Given the ridrs physics plugins together with a test device plugin "test-device" and a probe plugin "test-ui"
    And the plugins "physics-trainer-load, control-virtual-gears" are loaded as well
    And a test controller "test-ride"
    And a mock world "test-road" feeds the terrain ahead with a constant gradient of 0 % when the ride starts
    And the host has started
    And "test-ui" published "activity.start-requested"

  Scenario: The ride starts in gear 12
    Then the latest "drivetrain.gear-changed" event has the gear 12 of 24

  Scenario: Shift up and down
    When "test-ride" presses "shift-up-right" 3 times
    And "test-ride" presses "shift-down-left" once
    Then the latest "drivetrain.gear-changed" event has the gear 14 of 24

  Scenario: Holding a button shifts once
    When "test-ride" holds "shift-up-right" for 3 seconds
    Then the latest "drivetrain.gear-changed" event has the gear 13 of 24
    And 2 "drivetrain.gear-changed" events were published

  Scenario: The gears end at 1 and 24
    When "test-ride" presses "shift-up-right" 20 times
    Then the latest "drivetrain.gear-changed" event has the gear 24 of 24
    When "test-ride" presses "shift-down-right" 30 times
    Then the latest "drivetrain.gear-changed" event has the gear 1 of 24

  Scenario: A gear held for minutes still counts
    When "test-ride" presses "shift-up-right" once
    And "test-device" delivers only power 200 W every 0.25 s for 300 seconds
    Then the trainer load at "+300 s" names the virtual gear 13

  Scenario: A harder gear raises the load, not the speed
    When "test-ride" taps "shift-up-right" 4 times at once
    Then the latest "drivetrain.gear-changed" event has the gear 16 of 24
    When "test-device" delivers only power 200 W every 0.25 s for 60 seconds
    Then the trainer load with virtual gear at "+60 s" is higher than the trainer load
    # The same numbers as the Phase 6 ride on the flat without gears.
    And the virtual speed at "+60 s" is 33.87 km/h

  Scenario: The next ride starts in gear 12 again
    When "test-ride" presses "shift-up-right" 3 times
    And "test-ui" publishes "activity.finish-requested"
    And "test-ui" publishes "activity.start-requested"
    Then the latest "drivetrain.gear-changed" event has the gear 12 of 24
