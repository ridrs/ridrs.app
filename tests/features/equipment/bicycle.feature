@fake-timers
Feature: The bicycle from the garage is frozen for a ride
  The garage keeps one bicycle: its weight and its drivetrain, Shimano Di2 2 × 12 with 50-34
  chainrings and an 11-34 cassette, shifted in the mode the rider set (ADR 0060). The garage
  hands the bicycle to the ride as an input; when a ride starts, the activity session freezes it
  for that ride ("activity.equipment"), and the physics and the gears use the frozen bicycle until
  the ride ends. A change in the garage applies to the next ride. The recording keeps the input, so
  a replay and a continued ride use the recorded bicycle. Without a garage the physics keeps its
  defaults: 10 kg and 24 virtual gears.

  Background:
    Given the ridrs physics plugins, "recording-session" and "ui-garage" together with a test device plugin "test-device", a probe plugin "test-ui" and the memory storage
    And the plugins "physics-trainer-load, control-virtual-gears" are loaded as well
    And a test controller "test-ride"
    And a mock world "test-road" feeds the terrain ahead with a constant gradient of 5 % when the ride starts

  Scenario Outline: A heavier bicycle climbs slower
    Given the garage holds a bicycle of <bicycle> kg
    And the host has started
    And "test-ui" published "activity.start-requested" through the UI bridge
    When "test-device" delivers only power 200 W every 0.25 s for 60 seconds
    Then the ride froze a bicycle of <bicycle> kg
    And the latest physics state carries a total mass of <total> kg
    And the virtual speed at "+60 s" is <speed> km/h

    Examples:
      | bicycle | total | speed |
      | 10      | 85    | 14.90 |
      | 18      | 93    | 13.82 |

  Scenario: The ride starts in the start gear of the drivetrain
    Given the garage holds a bicycle of 10 kg in "manual" mode starting in 34 × 17
    And the host has started
    When "test-ui" publishes "activity.start-requested" through the UI bridge
    Then the latest "drivetrain.gear-changed" event shows 34 × 17
    And the latest "drivetrain.gear-changed" event has the gear 10 of 24

  Scenario: Manual: the right shifter moves the rear, the left one the front
    Given the garage holds a bicycle of 10 kg in "manual" mode starting in 34 × 17
    And the host has started
    And "test-ui" published "activity.start-requested" through the UI bridge
    When "test-ride" presses "shift-up-right" twice
    Then the latest "drivetrain.gear-changed" event shows 34 × 14
    When "test-ride" presses "shift-up-left" once
    Then the latest "drivetrain.gear-changed" event shows 50 × 14
    When "test-ride" presses "shift-up-left" once
    Then the latest "drivetrain.gear-changed" event shows 50 × 14
    When "test-ride" presses "shift-up-right" 5 times
    Then the latest "drivetrain.gear-changed" event shows 50 × 11

  Scenario: Semi-synchro: the rear compensates a front shift by two sprockets
    Given the garage holds a bicycle of 10 kg in "semi-synchro" mode starting in 34 × 17
    And the host has started
    And "test-ui" published "activity.start-requested" through the UI bridge
    When "test-ride" presses "shift-up-left" once
    Then the latest "drivetrain.gear-changed" event shows 50 × 21
    When "test-ride" presses "shift-down-left" once
    Then the latest "drivetrain.gear-changed" event shows 34 × 17

  Scenario: Full synchro: the right shifter alone switches the chainring at the shift points
    Given the garage holds a bicycle of 10 kg in "full-synchro" mode starting in 34 × 17
    And the host has started
    And "test-ui" published "activity.start-requested" through the UI bridge
    When "test-ride" presses "shift-up-right" once
    Then the latest "drivetrain.gear-changed" event shows 50 × 21
    When "test-ride" presses "shift-down-right" 3 times
    Then the latest "drivetrain.gear-changed" event shows 50 × 30
    When "test-ride" presses "shift-down-right" once
    Then the latest "drivetrain.gear-changed" event shows 34 × 24

  Scenario: The activity screen shifts the front and the rear
    Given the garage holds a bicycle of 10 kg in "manual" mode starting in 34 × 17
    And the host has started
    And "test-ui" published "activity.start-requested" through the UI bridge
    When the rider asks for a harder gear on the "front" derailleur in the activity screen
    Then the latest "drivetrain.gear-changed" event shows 50 × 17
    When the rider asks for a harder gear on the "rear" derailleur in the activity screen
    Then the latest "drivetrain.gear-changed" event shows 50 × 15

  Scenario: A change during a ride applies to the next ride
    Given the garage holds a bicycle of 10 kg in "manual" mode starting in 34 × 17
    And the host has started
    And "test-ui" published "activity.start-requested" through the UI bridge
    When the rider changes the bicycle in the garage to 18 kg starting in 50 × 15
    And "test-device" delivers only power 200 W every 0.25 s for 10 seconds
    Then the latest physics state carries a total mass of 85 kg
    And the latest "drivetrain.gear-changed" event shows 34 × 17
    When "test-ui" publishes "activity.finish-requested" through the UI bridge
    And "test-ui" publishes "activity.start-requested" through the UI bridge
    And "test-device" delivers only power 200 W every 0.25 s for 5 seconds
    Then the ride froze a bicycle of 18 kg
    And the latest physics state carries a total mass of 93 kg
    And the latest "drivetrain.gear-changed" event shows 50 × 15

  Scenario: The replay uses the recorded bicycle, whatever the garage holds now
    Given the garage holds a bicycle of 18 kg in "semi-synchro" mode starting in 34 × 17
    And the host has started
    And "test-ui" published "activity.start-requested" through the UI bridge
    And "test-device" delivered only power 200 W every 0.25 s for 10 seconds
    And "test-ride" presses "shift-up-left" once
    And "test-device" delivered only power 200 W every 0.25 s for 10 seconds
    And "test-ui" published "activity.finish-requested" through the UI bridge
    When the rider changes the bicycle in the garage to 12 kg starting in 50 × 11
    And the recording is replayed
    Then the replay is identical
    And the replay compared all of the "activity.equipment", "drivetrain.gear-changed" and "physics.state" events of the ride

  Scenario: A recording without a bicycle replays with the defaults
    Given the plugin "ui-garage" is not installed
    And the host has started
    And "test-ui" published "activity.start-requested" through the UI bridge
    And "test-device" delivered only power 200 W every 0.25 s for 10 seconds
    And "test-ui" published "activity.finish-requested" through the UI bridge
    When the recording is replayed
    Then the replay is identical
    And the ride froze no bicycle
    And the latest "drivetrain.gear-changed" event has the gear 12 of 24

  Scenario: A continued ride keeps its frozen bicycle
    Given the garage holds a bicycle of 18 kg in "manual" mode starting in 34 × 17
    And the host has started
    And "test-ui" published "activity.start-requested" through the UI bridge
    And "test-device" delivered only power 200 W every 0.25 s for 30 seconds
    And the machine lost power
    And the garage holds a bicycle of 12 kg in "manual" mode starting in 50 × 11
    And ridrs started again
    When the rider continues the interrupted ride
    And "test-ui" publishes "activity.resume-requested" through the UI bridge
    And "test-device" delivers only power 200 W every 0.25 s for 10 seconds
    Then the latest physics state carries a total mass of 93 kg
    And the latest "drivetrain.gear-changed" event shows 34 × 17
    When "test-ui" publishes "activity.finish-requested" through the UI bridge
    And the recording is replayed
    Then the replay is identical

  Scenario: The next ride after a continued one uses the garage's bicycle
    Given the garage holds a bicycle of 18 kg in "manual" mode starting in 34 × 17
    And the host has started
    And "test-ui" published "activity.start-requested" through the UI bridge
    And "test-device" delivered only power 200 W every 0.25 s for 30 seconds
    And the machine lost power
    And the garage holds a bicycle of 12 kg in "manual" mode starting in 50 × 11
    And ridrs started again
    When the rider continues the interrupted ride
    And "test-ui" publishes "activity.finish-requested" through the UI bridge
    And "test-ui" publishes "activity.start-requested" through the UI bridge
    Then the ride froze a bicycle of 12 kg
    And the latest "drivetrain.gear-changed" event shows 50 × 11
