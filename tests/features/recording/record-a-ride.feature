@phase-9 @fake-timers
Feature: Every ride is recorded
  From "Start ride" to "Finish ride", every event and every diagnostic is written in
  publish order - with a header, a configuration snapshot and a footer.

  Background:
    Given the ridrs physics plugins, "recording-session" and "export-fit" together with a test device plugin "test-device", a probe plugin "test-ui" and the memory storage
    And the host has started

  Scenario: Without a ride nothing is written
    When "test-device" delivers power 200 W every 0.25 s and heart rate 150 bpm every 1 s for 10 seconds
    Then the memory storage contains no files

  Scenario: A finished ride is saved as one compressed recording
    Given "test-ui" published "activity.start-requested" through the UI bridge
    And "test-device" delivered power 200 W every 0.25 s and heart rate 150 bpm every 1 s for 10 seconds
    When "test-ui" publishes "activity.finish-requested" through the UI bridge
    Then the memory storage contains "recordings/ride-20261101T100000Z-<session>.ridrs"
    And it contains no ".ridrs.jsonl" file
    And the latest "recording.completed" event names that file with a distance of 41.94 m and a duration of 10000 ms

  Scenario: The recording is header, snapshot, events and footer
    Given a ride from "+0 ms" to "+10 s" with power 200 W every 0.25 s and heart rate 150 bpm every 1 s was recorded
    Then the first record of the recording is a "header" with the format "ridrs.recording" version 1
    And the second record is a "snapshot"
    And the last record is a "footer" with the status "complete"
    And the event and diagnostic records are numbered 1, 2, 3 … without gaps, in publish order
    And the recording contains every "physics.state-batch" step from 0 to 1000 exactly once
    And every "physics.state", "metric.power", "metric.heart-rate" and "activity.state-changed" event of the ride is in the recording with its exact payload and timestamp

  Scenario: The snapshot describes the host and the physics parameters
    Given a ride from "+0 ms" to "+10 s" with power 200 W every 0.25 s and heart rate 150 bpm every 1 s was recorded
    Then the snapshot lists the plugin "physics-engine" with its version, types, provides and requires
    And the snapshot section "physics-rider" contains a mass of 75 and a CdA of 0.32
    And the snapshot section "physics-rolling-resistance" contains the surface factors "asphalt 1, gravel 2"
    And the snapshot contains the core temporal defaults

  Scenario: The minute before the ride is recorded as pre-roll
    Given "test-device" delivered power 200 W every 0.25 s and heart rate 150 bpm every 1 s for 90 seconds
    And "test-ui" published "activity.start-requested" through the UI bridge
    And "test-device" delivered power 200 W every 0.25 s and heart rate 150 bpm every 1 s for 5 more seconds
    When "test-ui" publishes "activity.finish-requested" through the UI bridge
    Then the recording's pre-roll events start at "+30 s"
    And every pre-roll event is marked as pre-roll
    And the first event that is not pre-roll is "activity.start-requested"

  Scenario: A storage failure loses the recording, not the ride
    Given the memory storage fails every write
    And "test-ui" published "activity.start-requested" through the UI bridge
    When "test-device" delivers power 200 W every 0.25 s and heart rate 150 bpm every 1 s for 10 seconds
    Then a "recording-failed" diagnostic was reported once
    And the virtual speed at "+10 s" is 22.24 km/h

  Scenario: An interrupted recording is recovered at the next start
    Given the memory storage contains an interrupted recording "recordings/ride-20261101T090000Z-0badc0de.ridrs.jsonl" whose last line is torn
    When the host restarts
    Then the memory storage contains "recordings/ride-20261101T090000Z-0badc0de.ridrs"
    And its footer has the status "recovered"
    And a "recording-recovered" diagnostic was reported
    And a "recording.completed" event names that file

  Scenario: Observing the whole host needs a declared permission
    Given a probe plugin "test-spy" without permissions calls "ctx.host.observe"
    Then the call failed with "permission-denied"
    And the manifest of "recording-session" declares the permission "observe-host"
