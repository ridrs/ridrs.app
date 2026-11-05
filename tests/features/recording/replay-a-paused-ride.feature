@phase-9 @fake-timers
Feature: A ride with a pause replays identically
  Pause and resume are rider inputs (ADR 0056): the replay injects them at their times and the
  simulation stands still in the pause exactly as it did live.

  Scenario: Replaying a paused ride gives identical results
    Given a simulated BLE environment with the Phase 2 trainer script "SIM KICKR" and a heart-rate band "SIM HRM"
    And the ridrs physics plugins, the device plugins, the metric plugins and "recording-session" together with a probe plugin "test-ui" and the memory storage
    And the host has started
    And 70 s pass
    And "test-ui" published "activity.start-requested" through the UI bridge
    And 10 s pass
    And "test-ui" published "activity.pause-requested" through the UI bridge
    And 15 s pass
    And "test-ui" published "activity.resume-requested" through the UI bridge
    And 10 s pass
    And "test-ui" published "activity.finish-requested" through the UI bridge
    When the recording is replayed
    Then the replay is identical
