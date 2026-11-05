@phase-9 @fake-timers
Feature: The open recording survives a power loss
  The open recording is the ride's journal (ADR 0055). It is appended once a second and flushed to
  the disk every 5 seconds and right after the ride starts, so a power loss loses at most the last
  few seconds of the ride, and every line left on the disk is complete.

  Background:
    Given the ridrs physics plugins, "recording-session" and "export-fit" together with a test device plugin "test-device", a probe plugin "test-ui" and the memory storage
    And the host has started

  Scenario: The start of a ride is on the disk at once
    Given "test-ui" published "activity.start-requested" through the UI bridge
    And 0.1 seconds pass
    When the machine loses power
    Then the open recording on the disk holds the "running" state of the ride

  Scenario: A power loss loses at most the last 6 seconds of the ride
    Given "test-ui" published "activity.start-requested" through the UI bridge
    And "test-device" delivered power 200 W every 0.25 s and heart rate 150 bpm every 1 s for 60 seconds
    When the machine loses power
    Then the open recording on the disk holds the ride up to at least "+54 s"
    And every line of the open recording on the disk is complete
