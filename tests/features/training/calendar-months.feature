@ui @training @budget
Feature: The large calendar reads the month it shows
  The large calendar of the Training area shows whole months; a start reads only the next two
  weeks of planned workouts and the last two of rides (ADR 0078). The month shown is asked for
  through `training.range.load` (ADR 0088): intervals.icu reads the planned workouts and the rides
  of the weeks the month shows, two requests, and keeps them with the rest of the plan. A month read
  stays valid for 15 minutes like the plan: paging back to it costs no request, and a stale month
  is shown at once and read again. Nothing is read for the months the rider does not page to.

  Here intervals.icu, the browser and the secret store are simulated. It is Wednesday 4 November
  2026.

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-settings, ui-area-training, ui-area-me, profile-local, planner-intervals-icu, ui-training-plan" together with the simulated intervals.icu
    And a test device plugin "test-device"
    And intervals.icu knows the athlete "Alex Rider" with an FTP of 250 W and a weight of 72 kg
    And intervals.icu plans:
      | date       | name         | duration | load |
      | 2026-10-14 | Sweet Spot   | 1h15m    | 78   |
      | 2026-11-02 | Threshold 20 | 1h       | 80   |
      | 2026-11-06 | Endurance    | 1h       | 50   |
      | 2026-12-17 | Endurance 90 | 1h30m    | 65   |
    And intervals.icu has done:
      | date       | name         | duration | load |
      | 2026-10-13 | Morning Ride | 45m      | 30   |
    And intervals.icu has the library:
      | folder | name            | type | duration | load |
      | Base   | Sweet Spot 3x12 | Ride | 1h15m    | 78   |
    And the local time is "2026-11-04 08:00"
    And the secret store holds a token for intervals.icu
    And the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown

  Scenario: Paging the months shows each month's plans and rides
    When I press "Training"
    And I press "Open large calendar"
    Then the calendar date "2026-11-02" lists "Threshold 20"
    And the calendar date "2026-11-06" lists "Endurance"
    When I press "Next month"
    Then the calendar date "2026-12-17" lists "Endurance 90"
    When I press "Previous month"
    And I press "Previous month"
    Then the calendar date "2026-10-14" lists "Sweet Spot"
    And the calendar date "2026-10-13" shows "Morning Ride" as done

  Scenario: A month costs two requests, for the weeks it shows
    When I press "Training"
    Then the library lists the workout "Sweet Spot 3x12" of "intervals.icu"
    When the simulated intervals.icu forgets the requests so far
    And I press "Open large calendar"
    Then intervals.icu received 2 requests
    And intervals.icu was asked for the events from "2026-10-26" to "2026-12-06"
    And intervals.icu was asked for the activities from "2026-10-26" to "2026-12-06"
    When I press "Next month"
    Then intervals.icu received 4 requests
    And intervals.icu was asked for the events from "2026-11-30" to "2027-01-03"

  Scenario: A month read in the last 15 minutes costs no request
    When I press "Training"
    And I press "Open large calendar"
    Then the calendar date "2026-11-02" lists "Threshold 20"
    When I press "Next month"
    Then the calendar date "2026-12-17" lists "Endurance 90"
    When the simulated intervals.icu forgets the requests so far
    And I press "Previous month"
    And I press "Next month"
    Then the calendar date "2026-12-17" lists "Endurance 90"
    And intervals.icu received 0 requests
    When the local time is "2026-11-04 08:20"
    And I press "Previous month"
    Then intervals.icu received 2 requests

  Scenario: A workout moved into a later month stays in that month
    When I press "Training"
    And I press "Open large calendar"
    And I press "Next month"
    And the rider moves the planned workout "Endurance" of "intervals.icu" to "2026-12-10"
    Then the calendar date "2026-12-10" lists "Endurance"

  Scenario: The next workout is still the next one from today, with the past days of the month read
    When I press "Training"
    And I press "Open large calendar"
    Then the calendar date "2026-11-02" lists "Threshold 20"
    When I press Back
    And I press Back
    Then the next workout card shows:
      | name | Endurance |

  Scenario: The months read are kept for a start without network
    When I press "Training"
    And I press "Open large calendar"
    And I press "Next month"
    Then the calendar date "2026-12-17" lists "Endurance 90"
    When the local time is "2026-11-04 08:30"
    And the host is restarted while intervals.icu is unreachable
    And the ridrs UI is shown
    And I press "Training"
    And I press "Open large calendar"
    And I press "Next month"
    Then the calendar date "2026-12-17" lists "Endurance 90"
