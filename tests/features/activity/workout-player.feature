@structured-workouts @fake-timers
Feature: The workout player rides the workout of a ride
  The workout enters the ride whole in `activity.start-requested`, with its targets resolved to
  watts at the start, and stays in the activity state through pause, resume and finish
  (structured-workouts.md, sections 11 and 11a). The host plugin `workout-player` rides it on the
  ridden time of the host clock: it sets the trainer's target power for a step with a power
  target, follows a ramp every second, leaves ERG for a step without one and when the workout is
  over, and says where it is in `workout.step-changed` and `workout.finished`. A pause holds the
  workout. "Next step" skips a step and ends an open one. While a step has a power target, only
  the player sets the target: the plus and minus of ERG are ignored.

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

  Scenario: The plus and minus of ERG are ignored during a power step, not during a free ride
    When the rider starts a ride with the workout "Mixed"
    And 10 s pass
    And the rider asks ERG for "up"
    And the rider asks ERG for "down"
    And the rider asks ERG for "leave"
    And 1 s passes
    Then the workout's target power was:
      | at    | target |
      | +11 s | 200 W  |
    When 180 s pass
    And the rider asks ERG for "enter"
    And 1 s passes
    Then the workout's target power was:
      | at     | target |
      | +190 s | off    |
      | +191 s | 150 W  |
