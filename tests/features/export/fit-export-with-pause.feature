@phase-9 @fake-timers
Feature: FIT export of a ride with a pause
  A pause stops the FIT timer and resuming starts it again (ADR 0056): the timer time is the
  time the ride ran, and no records are written while it stands still.

  Background:
    Given the ridrs physics plugins, "recording-session" and "export-fit" together with a test device plugin "test-device", a probe plugin "test-ui" and the memory storage
    And the host has started
    And "test-ui" published "activity.start-requested" through the UI bridge
    And "test-device" delivered power 200 W every 0.25 s and heart rate 150 bpm every 1 s for 10 seconds
    And "test-ui" published "activity.pause-requested" through the UI bridge
    And 20 seconds pass
    And "test-ui" published "activity.resume-requested" through the UI bridge
    And "test-device" delivered power 200 W every 0.25 s and heart rate 150 bpm every 1 s for 10 seconds
    When "test-ui" publishes "activity.finish-requested" through the UI bridge

  Scenario: The timer stops in the pause
    Then the FIT file is valid according to the official FIT SDK
    And the FIT file has the timer events:
      | type     | time  |
      | start    | +0 s  |
      | stop     | +10 s |
      | start    | +30 s |
      | stop_all | +40 s |
    And the FIT session has a total elapsed time of 40.000 s and a total timer time of 20.000 s

  Scenario: No records are written while the ride stands still
    Then the FIT file has 22 records, none from "+11 s" to "+29 s"
