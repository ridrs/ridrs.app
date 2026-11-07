@phase-9 @fake-timers
Feature: FIT export of a recorded ride
  Every saved ride is exported as a FIT activity file. ridrs writes FIT with its own
  encoder; the tests check every file with the official Garmin FIT SDK.

  Background:
    Given the ridrs physics plugins, "recording-session" and "export-fit" together with a test device plugin "test-device", a probe plugin "test-ui" and the memory storage
    And the host has started
    And a ride from "+0 ms" to "+10 s" with power 200 W every 0.25 s and heart rate 150 bpm every 1 s was recorded

  Scenario: The FIT file is written and valid
    Then the memory storage contains "recordings/ride-20261101T100000Z-<session>.fit"
    And the latest "export.fit" state names that file with 11 records
    And the FIT file is valid according to the official FIT SDK

  Scenario: A restarted FIT export writes no file again
    Given the memory storage contains "recordings/ride-20261101T100000Z-<session>.fit"
    When the plugin "export-fit" is stopped
    And the plugin "export-fit" is started
    Then the FIT file of the first ride was written only once
    And the latest "export.fit" state names that file with no record count

  Scenario: The file describes a virtual cycling activity
    Then the FIT file has one "file_id" message of the type "activity" from the manufacturer "development"
    And the FIT file has one "session" message with the sport "cycling" and the sub-sport "virtual_activity"
    And the FIT file has one "lap" message and one "activity" message with 1 session
    And the FIT file has a timer "start" event at "+0 ms" and a timer "stop_all" event at "+10 s"

  Scenario Outline: The record at <time>
    Then the FIT record at "<time>" has a power of <power> W, a heart rate of <hr> bpm, a speed of <speed> m/s and a distance of <distance> m

    Examples:
      | time  | power | hr  | speed | distance |
      | +0 s  | 200   | 150 | 0.000 | 0.00     |
      | +5 s  | 200   | 150 | 4.532 | 14.79    |
      | +10 s | 200   | 150 | 6.179 | 41.94    |

  Scenario: Missing values are absent, never zero
    Then every FIT record has no cadence

  Scenario: The session summarises the ride
    Then the FIT session has a total elapsed time of 10.000 s and a total timer time of 10.000 s
    And the FIT session has a total distance of 41.94 m
    And the FIT session has an average speed of 4.194 m/s and a maximum speed of 6.179 m/s
    And the FIT session has an average power of 200 W and a maximum power of 200 W
    And the FIT session has an average heart rate of 150 bpm and a maximum heart rate of 150 bpm

  Scenario: The CLI export is byte-identical to the automatic export
    When the recording is exported with "ridrs-headless recording export-fit"
    Then the CLI's FIT file is byte-identical to the automatic one

  Scenario: The official SDK is not part of ridrs
    Then no source file outside the tests imports "@garmin/fitsdk"
