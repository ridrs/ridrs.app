@phase-9 @fake-timers
Feature: An interrupted ride goes on where its journal ends
  After a crash or a power loss, the next start offers the interrupted ride (ADR 0057). Continuing
  rebuilds it from the committed part of its journal: the same session, its distance and its step
  numbers, paused until the rider resumes. The interruption is recorded and is no riding time.
  Finishing it seals it as recovered, as before.

  Background:
    Given the ridrs physics plugins, "recording-session" and "export-fit" together with a test device plugin "test-device", a probe plugin "test-ui" and the memory storage
    And the host has started
    And "test-ui" published "activity.start-requested" through the UI bridge
    And "test-device" delivered only power 200 W every 0.25 s for 30 seconds
    And the machine lost power
    And 60 s pass
    And ridrs started again

  Scenario: The next start offers the interrupted ride
    Then ridrs offers to continue the interrupted ride
    And the memory storage still holds its open recording

  Scenario: The continued ride keeps its session and stands still in the interruption
    When the rider continues the interrupted ride
    Then the latest "activity.state-changed" event has the state "paused"
    And it was paused because the ride was interrupted
    And it carries the session of the interrupted ride
    And the continued ride's latest "physics.state" is from before the interruption
    When 30 s pass
    Then no physics step ran since the interruption

  Scenario: The continued ride goes on after Resume and replays identically
    Given the rider continued the interrupted ride
    When "test-ui" publishes "activity.resume-requested" through the UI bridge
    And "test-device" delivers only power 200 W every 0.25 s for 10 seconds
    And "test-ui" publishes "activity.finish-requested" through the UI bridge
    Then the recording of the interrupted ride is complete
    And its activity states are "running, paused, running, finished"
    And its physics steps go on without a gap in their numbers
    When the recording is replayed
    Then the replay is identical

  Scenario: Finishing the interrupted ride seals it as recovered
    When the rider finishes the interrupted ride
    Then the recording of the interrupted ride is sealed with the status "recovered"
    And ridrs offers no interrupted ride any more
