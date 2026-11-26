@fake-timers
Feature: A sealed recording's file name sums up its ride
  Each ride is one file, and its name holds what the rides saved on this device show (ADR 0111):
  the local start with its offset, the session, the duration, the planned entry and the workout's
  name. So the folder listing is the index: the history reads no recording at start, however many
  and however long the rides are. Recordings named before are read once and renamed, after the
  start.

  Scenario: The ride of a planned workout is named after it
    Given the workout "Sweet Spot 3x12" for the workout player:
      | duration | target |
      | 1 min    | 200 W  |
    And the workout player runs with the ridrs plugins "activity-session, workout-player, control-erg, recording-session, history-ridrs" and the memory storage
    And the host has started
    When the rider starts a ride with the workout "Sweet Spot 3x12" planned as the "intervals" entry "evt/7"
    And 10 s pass
    And "test-ui" publishes "activity.finish-requested"
    Then the memory storage contains "recordings/ride-<local start>~<session>~10s~intervals=evt%2F7~Sweet Spot 3x12.ridrs"

  Scenario: The history is read from the file names alone
    Given the workout player runs with the ridrs plugins "history-ridrs" and the memory storage
    And the recordings hold these files, whose content cannot be read:
      | file                                                                                                       |
      | ride-20261124T112908.647+0100~295f70db9baaa0e0_activity-session_1795516148647_0~5431s~intervals.icu=146155281~The One That Stays Controlled 🎚️.ridrs |
      | ride-20261126T075123.534+0100~074d94f2d54c16ea_activity-session_1795675883534_0~29s~-~Oxygen Thief 7×4.ridrs |
      | ride-20261124T112908.647+0100~295f70db9baaa0e0_activity-session_1795516148647_0~5431s~intervals.icu=146155281~The One That Stays Controlled 🎚️.fit |
      | ride-20261124T102908Z-screenshot_00.jpg                                                                     |
    When the host has started
    Then the rides saved on this device are, with the status "ready":
      | id                                                | date       | started at               | name                              | duration | planned                 |
      | 295f70db9baaa0e0:activity-session:1795516148647:0 | 2026-11-24 | 2026-11-24T10:29:08.647Z | The One That Stays Controlled 🎚️ | 5431     | intervals.icu 146155281 |
      | 074d94f2d54c16ea:activity-session:1795675883534:0 | 2026-11-26 | 2026-11-26T06:51:23.534Z | Oxygen Thief 7×4                  | 29       |                         |
    And no recording was read

  Scenario: A recording named before is renamed once, with its FIT file
    Given the workout player runs with the ridrs plugins "history-ridrs" and the memory storage
    And the recordings hold the sealed ride "ride-20261101T090000Z-0badc0de.ridrs" of 120 s with the workout "Sweet Spot ⏳ 2×20" planned as the "intervals" entry "evt-7", and its FIT file
    When the host has started
    Then the recordings come to hold "ride-20261101T100000.000+0100~0badc0de-0000-4000-8000-000000000000~120s~intervals=evt-7~Sweet Spot ⏳ 2×20.ridrs, ride-20261101T100000.000+0100~0badc0de-0000-4000-8000-000000000000~120s~intervals=evt-7~Sweet Spot ⏳ 2×20.fit" and nothing else
    And the renamed recording has the bytes of the old one
    And the rides saved on this device are, with the status "ready":
      | id                                   | date       | started at               | name               | duration | planned      |
      | 0badc0de-0000-4000-8000-000000000000 | 2026-11-01 | 2026-11-01T09:00:00.000Z | Sweet Spot ⏳ 2×20 | 120      | intervals evt-7 |
