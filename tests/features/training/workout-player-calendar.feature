@structured-workouts @fake-timers
Feature: A ride with a planned workout names its planned entry when it is done
  The ride's workout is part of its activity state, so the recording keeps which workout was
  ridden and which planned entry it came from. The rides saved on this device
  (`training.history` of `ridrs`) name that entry, so the calendar can match the done ride with
  its plan (ADR 0076), and carry the workout's name.

  Scenario: The done ride names its planned entry
    Given the workout "Sweet Spot 3x12" for the workout player:
      | duration | target |
      | 1 min    | 200 W  |
    And the workout player runs with the ridrs plugins "activity-session, workout-player, control-erg, recording-session, history-ridrs" and the memory storage
    And the host has started
    When the rider starts a ride with the workout "Sweet Spot 3x12" planned as the "intervals" entry "evt-7"
    And 10 s pass
    And "test-ui" publishes "activity.finish-requested"
    Then the rides saved on this device list the ride as "Sweet Spot 3x12", done for the "intervals" entry "evt-7"

  Scenario: A ride without a workout names no planned entry
    Given the workout player runs with the ridrs plugins "activity-session, workout-player, control-erg, recording-session, history-ridrs" and the memory storage
    And the host has started
    When "test-ui" publishes "activity.start-requested"
    And 10 s pass
    And "test-ui" publishes "activity.finish-requested"
    Then the rides saved on this device list the ride as "Ride", without a planned entry
