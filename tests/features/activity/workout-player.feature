@structured-workouts @fake-timers
Feature: The workout player rides the workout of a ride
  The workout enters the ride whole in `activity.start-requested`, with its targets resolved to
  watts at the start, and stays in the activity state through pause, resume and finish
  (structured-workouts.md, sections 11 and 11a). The host plugin `workout-player` rides it on the
  ridden time of the host clock: it sets the trainer's target power for a step with a power
  target, follows a ramp every second, leaves ERG for a step without one and when the workout is
  over, and says where it is in `workout.step-changed` and `workout.finished`. A pause holds the
  workout. "Next step" skips a step and ends an open one. While a step has a power target, only
  the player sets the target, unless the rider leaves ERG: then the trainer rides on the gradient
  and the gears, at a load of the rider's own, through every step until the rider enters ERG
  again and the workout takes the target back. While the workout holds the target, the plus and
  minus of ERG and the power-up buttons of a controller change the workout's intensity instead, in steps of 1 % from 100 % down to 50 % and up to
  150 %. The ERG driver accepts the intensity as rider input (`workout.intensity-changed`); the
  player scales every power target of the workout by it, from then on, until the ride ends.

  Background:
    Given the workout "Mixed" for the workout player:
      | duration | target         |
      | 2 min    | 200 W          |
      | 1 min    | 150 W to 250 W |
      | 1 min    | free ride      |
    And the workout player runs with the ridrs plugins "activity-session, workout-player, control-erg"
    And the host has started

  Scenario: The activity state carries the workout from the start to the finish
    When the rider starts a ride with the workout "Mixed" planned as the "intervals" entry "evt-7"
    And 30 s pass
    And "test-ui" publishes "activity.pause-requested"
    And "test-ui" publishes "activity.resume-requested"
    And "test-ui" publishes "activity.finish-requested"
    Then every activity state of the ride carries the workout "Mixed" planned as the "intervals" entry "evt-7"

  Scenario: The workout sets its targets at their times
    When the rider starts a ride with the workout "Mixed"
    And 250 s pass
    Then the workout's target power was:
      | at     | target |
      | +0 s   | 200 W  |
      | +119 s | 200 W  |
      | +120 s | 150 W  |
      | +121 s | 152 W  |
      | +150 s | 200 W  |
      | +179 s | 248 W  |
      | +180 s | off    |
      | +250 s | off    |
    And the ramp's target changed every second from "+120 s" to "+179 s"
    And the workout's steps began at "+0 s, +120 s, +180 s"
    And the workout finished at "+240 s"

  Scenario: A pause holds the workout
    When the rider starts a ride with the workout "Mixed"
    And 60 s pass
    And "test-ui" publishes "activity.pause-requested"
    And 300 s pass
    And "test-ui" publishes "activity.resume-requested"
    And 70 s pass
    Then the workout's steps began at "+0 s, +420 s"
    And the workout player set no target power between "+1 s" and "+419 s"

  Scenario: "Next step" skips the step
    When the rider starts a ride with the workout "Mixed"
    And 30 s pass
    And the rider asks the workout player for the next step
    And 30 s pass
    Then the workout's steps began at "+0 s, +30 s"
    And the workout's target power was:
      | at    | target |
      | +29 s | 200 W  |
      | +30 s | 150 W  |
      | +60 s | 200 W  |

  Scenario: An open step waits for "Next step"
    Given the workout "Open" for the workout player:
      | duration | target |
      | open     | 180 W  |
      | 1 min    | 220 W  |
    When the rider starts a ride with the workout "Open"
    And 600 s pass
    Then the workout's steps began at "+0 s"
    When the rider asks the workout player for the next step
    And 1 s passes
    Then the workout's steps began at "+0 s, +600 s"
    And the workout's target power was:
      | at     | target |
      | +599 s | 180 W  |
      | +600 s | 220 W  |

  Scenario: The rider leaves the workout's ERG and rides at a load of their own
    When the rider starts a ride with the workout "Mixed"
    And 10 s pass
    And the rider asks ERG for "leave"
    And 1 s passes
    Then the workout's target power was:
      | at    | target |
      | +9 s  | 200 W  |
      | +10 s | off    |
      | +11 s | off    |
    When 115 s pass
    And the rider asks ERG for "up"
    And the rider presses the controller's "power-up-left"
    And 1 s passes
    Then the workout's intensity is 100 %
    And the workout's steps began at "+0 s, +120 s"
    And the workout's target power was:
      | at     | target |
      | +120 s | off    |
      | +127 s | off    |

  Scenario: Entering ERG again hands the target back to the workout
    When the rider starts a ride with the workout "Mixed"
    And 10 s pass
    And the rider asks ERG for "leave"
    And 116 s pass
    And the rider asks ERG for "enter"
    And 1 s passes
    Then the workout's target power was:
      | at     | target |
      | +125 s | off    |
      | +126 s | 160 W  |
      | +127 s | 162 W  |
    When the rider asks ERG for "up"
    And 1 s passes
    Then the workout's intensity is 101 %

  Scenario: During a free ride ERG is the rider's own
    When the rider starts a ride with the workout "Mixed"
    And 190 s pass
    And the rider asks ERG for "enter"
    And 1 s passes
    Then the workout's target power was:
      | at     | target |
      | +189 s | off    |
      | +190 s | 150 W  |
    When the rider asks ERG for "up"
    And 1 s passes
    Then the workout's target power was:
      | at     | target |
      | +191 s | 155 W  |

  Scenario: The plus and minus of ERG change the workout's intensity in steps of 1 %
    When the rider starts a ride with the workout "Mixed"
    And 10 s pass
    And the rider asks ERG for "up"
    And the rider asks ERG for "up"
    And 175 s pass
    Then the workout's intensity is 102 %
    And the workout's target power was:
      | at     | target |
      | +9 s   | 200 W  |
      | +10 s  | 204 W  |
      | +119 s | 204 W  |
      | +120 s | 153 W  |
      | +179 s | 253 W  |
      | +180 s | off    |
    When the rider asks ERG for "down"
    And 1 s passes
    Then the workout's intensity is 102 %
    And the workout's target power was:
      | at     | target |
      | +186 s | off    |

  Scenario: The intensity stays between 50 % and 150 %
    When the rider starts a ride with the workout "Mixed"
    And 10 s pass
    And the rider asks ERG for "down" 51 times
    And 1 s passes
    Then the workout's intensity is 50 %
    And the workout's target power was:
      | at    | target |
      | +11 s | 100 W  |
    When the rider asks ERG for "up" 101 times
    And 1 s passes
    Then the workout's intensity is 150 %
    And the workout's target power was:
      | at    | target |
      | +12 s | 300 W  |

  Scenario: The power-up buttons of a controller change the intensity during a power step
    When the rider starts a ride with the workout "Mixed"
    And 10 s pass
    And the rider presses the controller's "power-up-left"
    And 1 s passes
    Then the workout's intensity is 99 %
    And the workout's target power was:
      | at    | target |
      | +11 s | 198 W  |

  Scenario: A new ride starts its workout at 100 %
    When the rider starts a ride with the workout "Mixed"
    And 10 s pass
    And the rider asks ERG for "up"
    And "test-ui" publishes "activity.finish-requested"
    And the rider starts a ride with the workout "Mixed"
    And 1 s passes
    Then the workout's intensity is 100 %
    And the workout's target power was:
      | at   | target |
      | +1 s | 200 W  |

  Scenario: Loading, switching and clearing a workout during an ongoing ride
    Given the workout "Sprint" for the workout player:
      | duration | target |
      | 1 min    | 320 W  |
      | 1 min    | 140 W  |
    When the rider starts a ride without a workout
    And 30 s pass
    And "test-ui" publishes "activity.pause-requested"
    And the rider switches the ride's workout to "Mixed"
    And "test-ui" publishes "activity.resume-requested"
    And 15 s pass
    And the rider asks ERG for "up"
    And "test-ui" publishes "activity.pause-requested"
    And the rider switches the ride's workout to "Sprint"
    And "test-ui" publishes "activity.resume-requested"
    And 65 s pass
    Then the workout's target power was:
      | at     | target |
      | +30 s  | 200 W  |
      | +45 s  | 320 W  |
      | +104 s | 320 W  |
      | +105 s | 140 W  |
    When "test-ui" publishes "activity.pause-requested"
    And the rider clears the ride's workout
    And "test-ui" publishes "activity.resume-requested"
    And 5 s pass
    Then the workout's target power was:
      | at     | target |
      | +110 s | off    |
