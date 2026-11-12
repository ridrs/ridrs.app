@structured-workouts @fake-timers
Feature: The workout player on a ride with the physics, a route and the recorder
  A distance step ends by the virtual distance. Workout and route may have different lengths
  (structured-workouts.md, section 11): when the workout ends first, ERG ends and the ride goes on
  as a free ride on the gradient of the route; when the route ends first, the picture stands still
  and the gradient is 0 % beyond its end (the world says so, as the video world does), the
  workout goes on to its end and then a free ride follows at 0 %. Continuing an interrupted ride
  goes on at the same step, "Next step" is recorded rider input, and a replay gives the same
  targets and steps at the same times.

  Background:
    Given the workout player rides with the ridrs physics plugins, the trainer load, the recorder and the memory storage
    And the workout "Short" for the workout player:
      | duration | target         |
      | 20 s     | 200 W          |
      | 10 s     | 150 W to 250 W |
      | 10 s     | free ride      |

  Scenario: A distance step ends by the virtual distance
    Given the workout "Bridge" for the workout player:
      | duration | target |
      | 100 m    | 200 W  |
      | 30 s     | 150 W  |
    And the host has started
    When the rider starts a ride with the workout "Bridge"
    And "test-device" delivers only power 200 W every 0.25 s for 40 seconds
    Then the workout's steps began 2 times
    And the workout's second step began within a second of the virtual distance passing 100 m

  Scenario: The workout ends before the route: ERG ends, a free ride on the gradient of the route
    Given the workout "Twenty" for the workout player:
      | duration | target |
      | 20 s     | 200 W  |
    And the workout player's route is 2000 m long at a gradient of 4 %
    And the host has started
    When the rider starts a ride with the workout "Twenty" on the route
    And "test-device" delivers only power 200 W every 0.25 s for 30 seconds
    Then the workout finished at "+20 s"
    And the workout's target power was:
      | at    | target |
      | +19 s | 200 W  |
      | +20 s | off    |
      | +30 s | off    |
    And the trainer's load at "+30 s" has the gradient 4 %, within the route

  Scenario: The route ends before the workout: the workout goes on, then a free ride at 0 %
    Given the workout "Forty" for the workout player:
      | duration | target |
      | 40 s     | 200 W  |
    And the workout player's route is 40 m long at a gradient of 4 %
    And the host has started
    When the rider starts a ride with the workout "Forty" on the route
    And "test-device" delivers only power 200 W every 0.25 s for 50 seconds
    Then the ride passed the end of the route before "+30 s"
    And the workout's target power was:
      | at    | target |
      | +30 s | 200 W  |
      | +39 s | 200 W  |
      | +40 s | off    |
      | +50 s | off    |
    And the workout finished at "+40 s"
    And the trainer's load at "+50 s" has the gradient 0 %, beyond the end of the route

  Scenario: Continuing an interrupted ride goes on at the same step
    Given the host has started
    And the rider started a ride with the workout "Short"
    And "test-device" delivered only power 200 W every 0.25 s for 25 seconds
    And the machine lost power
    And 60 s pass
    And ridrs started again
    When the rider continues the interrupted ride
    Then the continued ride is at the workout's step 2
    When "test-ui" publishes "activity.resume-requested" through the UI bridge
    And "test-device" delivers only power 200 W every 0.25 s for 20 seconds
    Then the workout's step 3 began after 30 s of ridden time
    And the workout finished after 40 s of ridden time
    When "test-ui" publishes "activity.finish-requested" through the UI bridge
    And the recording is replayed
    Then the replay is identical

  Scenario: "Next step" is recorded, and a replay gives the same targets and steps
    Given the host has started
    When the rider starts a ride with the workout "Short"
    And "test-device" delivers only power 200 W every 0.25 s for 5 seconds
    And the rider asks the workout player for the next step
    And "test-device" delivers only power 200 W every 0.25 s for 25 more seconds
    And "test-ui" publishes "activity.finish-requested" through the UI bridge
    Then the recording holds the rider's "workout.next-step-requested" as an input at "+5 s"
    And the workout's steps began at "+0 s, +5 s, +15 s"
    When the recording is replayed
    Then the replay is identical
    And the replay compared every "trainer.target-power" event of the ride, and there was at least one
    And the replay compared every "workout.step-changed" event of the ride, and there was at least one
    And the replay compared every "workout.finished" event of the ride, and there was at least one
