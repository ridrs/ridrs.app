@structured-workouts @fake-timers
Feature: The workout halts while the rider cannot hold its power target
  In ERG the trainer holds the power: as the cadence falls, the torque at the crank grows, and who
  stops pedalling at a high target cannot get back in (ADR 0113). So the workout halts itself
  when the rider stops pedalling (no power in two reports in a row) or the cadence spirals down
  (below 45 rpm for 3 s while the trainer cannot hold the target or the cadence falls). Only the
  workout halts: the ride goes on, the trainer rides on the gradient of the route, the step's time
  stands. Pedalling at 30 rpm or more for 2 s starts a countdown of 5 s, during which the target
  rises from the power pedalled to the step's; it counts only at 55 rpm or more, and after its
  first 2 s it ends below 30 rpm. Then the workout runs on where it stood. The player looks every
  250 ms; a measurement arrives after the look of the same time. Without power and cadence the
  workout never halts. A spiral within 60 s after a countdown lowers the step's target by 5 %,
  down to 80 %, until the next step.

  Background:
    Given the workout "Hard" for the workout player:
      | duration | target    |
      | 40 s     | 300 W     |
      | 1 min    | 150 W     |
      | 1 min    | free ride |
    And the workout player runs with the ridrs plugins "activity-session, workout-player, control-erg, metric-power, metric-cadence" and a test device
    And the host has started
    And the rider started a ride with the workout "Hard"

  Scenario: Stopping halts the workout, and the trainer rides the route
    Given "test-device" delivered power 300 W and cadence 90 rpm every 1 s for 20 seconds
    When "test-device" delivers power 0 W and cadence 0 rpm every 1 s for 10 more seconds
    Then the workout's halt was:
      | at       | halt    |
      | +22 s    | running |
      | +22.25 s | halted  |
      | +30 s    | halted  |
    And the workout's target power was:
      | at       | target |
      | +22 s    | 300 W  |
      | +22.25 s | off    |
      | +30 s    | off    |

  Scenario: Pedalling again counts down 5 s while the target rises, then the workout runs where it stood
    Given "test-device" delivered power 300 W and cadence 90 rpm every 1 s for 20 seconds
    When "test-device" delivers power 0 W and cadence 0 rpm every 1 s for 10 more seconds
    And "test-device" delivers power 100 W and cadence 90 rpm every 1 s for 30 more seconds
    Then the workout's halt was:
      | at       | halt        |
      | +33 s    | halted      |
      | +33.25 s | countdown 5 |
      | +34.25 s | countdown 4 |
      | +38 s    | countdown 1 |
      | +38.25 s | running     |
    And the workout's target power was:
      | at       | target |
      | +33.25 s | off    |
      | +33.5 s  | 110 W  |
      | +35.25 s | 180 W  |
      | +38 s    | 290 W  |
      | +38.25 s | 300 W  |
    And the workout's steps began at "+0 s, +56 s"

  Scenario: Slow pedalling shows the countdown, but it does not count and the load stays
    Given "test-device" delivered power 300 W and cadence 90 rpm every 1 s for 20 seconds
    When "test-device" delivers power 0 W and cadence 0 rpm every 1 s for 10 more seconds
    And "test-device" delivers power 40 W and cadence 40 rpm every 1 s for 10 more seconds
    And "test-device" delivers power 100 W and cadence 90 rpm every 1 s for 10 more seconds
    Then the workout's halt was:
      | at       | halt                |
      | +33.25 s | countdown 5 waiting |
      | +41 s    | countdown 5 waiting |
      | +41.25 s | countdown 5         |
      | +46 s    | running             |
    And the workout's target power was:
      | at       | target |
      | +41 s    | off    |
      | +46 s    | 300 W  |

  Scenario: Below 30 rpm after its first 2 s the countdown ends, and the workout stays halted
    Given "test-device" delivered power 300 W and cadence 90 rpm every 1 s for 20 seconds
    When "test-device" delivers power 0 W and cadence 0 rpm every 1 s for 10 more seconds
    And "test-device" delivers power 40 W and cadence 40 rpm every 1 s for 5 more seconds
    And "test-device" delivers power 10 W and cadence 20 rpm every 1 s for 5 more seconds
    Then the workout's halt was:
      | at       | halt                |
      | +33.25 s | countdown 5 waiting |
      | +36.25 s | halted              |
      | +40 s    | halted              |
    And the workout player set no target power between "+23 s" and "+40 s"

  Scenario: A spiral halts the workout
    Given "test-device" delivered power 300 W and cadence 90 rpm every 1 s for 20 seconds
    When "test-device" delivers power 240 W and cadence 40 rpm every 1 s for 6 more seconds
    Then the workout's halt was:
      | at       | halt    |
      | +24 s    | running |
      | +24.25 s | halted  |

  Scenario: Pedalling a power target at a low cadence does not halt the workout
    Given "test-device" delivered power 300 W and cadence 90 rpm every 1 s for 20 seconds
    When "test-device" delivers power 300 W and cadence 40 rpm every 1 s for 15 more seconds
    Then the workout did not halt

  Scenario: A single report of no cadence while pedalling does not halt the workout
    Given "test-device" delivered power 300 W and cadence 90 rpm every 1 s for 20 seconds
    When "test-device" delivers power 300 W and cadence 0 rpm every 1 s for 1 more second
    And "test-device" delivers power 300 W and cadence 90 rpm every 1 s for 10 more seconds
    Then the workout did not halt

  Scenario: Without a cadence the workout never halts
    Given "test-device" delivered only power 300 W every 1 s for 20 seconds
    When "test-device" delivers only power 0 W every 1 s for 10 more seconds
    And 10 s pass
    Then the workout did not halt

  Scenario: The rider's pause stops the ride; the workout waits again for the first pedal strokes
    Given "test-device" delivered power 300 W and cadence 90 rpm every 1 s for 20 seconds
    When "test-ui" publishes "activity.pause-requested"
    And "test-device" delivers power 0 W and cadence 0 rpm every 1 s for 60 more seconds
    And "test-ui" publishes "activity.resume-requested"
    And "test-device" delivers power 0 W and cadence 0 rpm every 1 s for 5 more seconds
    Then the workout's halt was:
      | at    | halt   |
      | +80 s | halted |
      | +85 s | halted |
    And the workout's target power was:
      | at    | target |
      | +80 s | off    |

  Scenario: Leaving ERG while the workout is halted lets it run at a load of the rider's own
    Given "test-device" delivered power 300 W and cadence 90 rpm every 1 s for 20 seconds
    When "test-device" delivers power 0 W and cadence 0 rpm every 1 s for 10 more seconds
    And the rider asks ERG for "leave"
    And 30 s pass
    Then the workout's halt was:
      | at    | halt    |
      | +30 s | running |
    And the workout's steps began at "+0 s, +47.75 s"
    And the workout's target power was:
      | at    | target |
      | +60 s | off    |

  Scenario: A spiral soon after a countdown lowers the step's target by 5 %, until the next step
    Given "test-device" delivered power 300 W and cadence 90 rpm every 1 s for 20 seconds
    When "test-device" delivers power 0 W and cadence 0 rpm every 1 s for 10 more seconds
    And "test-device" delivers power 100 W and cadence 90 rpm every 1 s for 20 more seconds
    And "test-device" delivers power 240 W and cadence 40 rpm every 1 s for 6 more seconds
    And "test-device" delivers power 300 W and cadence 90 rpm every 1 s for 15 more seconds
    Then the workout's halt was:
      | at       | halt               |
      | +54.25 s | halted at 95 %     |
      | +64.25 s | running at 95 %    |
      | +66 s    | running            |
    And the workout's target power was:
      | at       | target |
      | +64.25 s | 285 W  |
      | +66 s    | 150 W  |

  Scenario: A step without a power target never halts
    Given the workout "Free" for the workout player:
      | duration | target    |
      | 1 min    | free ride |
    And "test-device" delivered power 300 W and cadence 90 rpm every 1 s for 20 seconds
    When the rider switches the ride's workout to "Free"
    And "test-device" delivers power 0 W and cadence 0 rpm every 1 s for 10 more seconds
    Then the workout did not halt
