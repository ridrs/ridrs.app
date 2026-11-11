@ui @training
Feature: The Training area shows the workouts that were done
  Each day of the calendar lists what was planned and what was done in it (ADR 0076). A ride is done when a
  provider says so: every provider of the data type `training.history` adds to the column, no
  source is chosen. The rides saved on this device and the activities of intervals.icu are listed
  together, and a ride that both know, a ride of ridrs uploaded to intervals.icu, is listed once.
  A planned workout that was ridden on its day is listed once too, as done and as planned: the done
  ride matches the plan by its name, or by its duration and load.

  Here intervals.icu, the browser and the secret store are simulated. It is Wednesday 4 November
  2026.

  Background:
    Given the ridrs plugins "activity-session, recording-session, export-fit, history-ridrs, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-activity-screen, ui-debriefing, ui-settings, ui-area-training, ui-area-me, profile-local, planner-intervals-icu, ui-training-plan" together with the simulated intervals.icu
    And a test device plugin "test-device"
    And intervals.icu knows the athlete "Alex Rider" with an FTP of 250 W and a weight of 72 kg
    And the local time is "2026-11-04 08:00"

  Scenario: An activity of intervals.icu is listed on its day
    Given intervals.icu has done:
      | date       | type | name        | duration | load |
      | 2026-11-02 | Ride | Sweet Spot  | 1h       | 75   |
    And the secret store holds a token for intervals.icu
    And the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Training"
    Then the calendar day "Monday" shows "Sweet Spot" as done
    And the calendar day "Tuesday" shows 0 done rides

  Scenario: A ride saved on this device is listed on today
    Given the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Start ride"
    And I press "Finish ride"
    And I press "Save"
    Then the "main" screen is shown
    When I press "Training"
    Then the calendar day "Wednesday" shows 1 done ride

  Scenario: A ride that is on this device and in intervals.icu is listed once
    Given the secret store holds a token for intervals.icu
    And the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Start ride"
    And I press "Finish ride"
    And the debriefing shows "Save uploads the ride to intervals.icu"
    And I press "Save"
    Then intervals.icu received the ride's FIT file as an activity with the session as its external id
    And the "main" screen is shown
    When intervals.icu has the uploaded ride as an activity named "Evening spin"
    And I open the next workout
    And I press "Refresh"
    And I press Back
    And I press "Training"
    Then the calendar day "Wednesday" shows 1 done ride
    And the calendar day "Wednesday" shows "Evening spin" as done

  Scenario: A planned workout that was ridden on its day is listed once, as done as planned
    Given intervals.icu plans:
      | date       | type | name         | duration | load |
      | 2026-11-04 | Ride | Threshold 20 | 1h       | 80   |
      | 2026-11-06 | Ride | Endurance 90 | 1h30m    | 65   |
    And intervals.icu has done:
      | date       | type | name         | duration | load |
      | 2026-11-04 | Ride | Threshold 20 | 1h2m     | 82   |
    And the secret store holds a token for intervals.icu
    And the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Training"
    Then the calendar day "Wednesday" shows "Threshold 20" as done as planned
    And the calendar day "Wednesday" lists 0 planned workouts
    And the calendar day "Friday" lists 1 planned workout

  Scenario: A ride of another name matches the plan of its day by its duration and load
    Given intervals.icu plans:
      | date       | type | name         | duration | load |
      | 2026-11-04 | Ride | Threshold 20 | 1h       | 80   |
    And intervals.icu has done:
      | date       | type | name          | duration | load |
      | 2026-11-04 | Ride | Morning Ride  | 58m      | 78   |
    And the secret store holds a token for intervals.icu
    And the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Training"
    Then the calendar day "Wednesday" shows "Morning Ride" as done as planned
    And the calendar day "Wednesday" lists 0 planned workouts

  Scenario: A ride that does not match the plan of its day leaves the plan listed
    Given intervals.icu plans:
      | date       | type | name         | duration | load |
      | 2026-11-04 | Ride | Threshold 20 | 1h       | 80   |
    And intervals.icu has done:
      | date       | type | name          | duration | load |
      | 2026-11-04 | Ride | Recovery Spin | 30m      | 20   |
    And the secret store holds a token for intervals.icu
    And the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Training"
    Then the calendar day "Wednesday" shows 1 done ride
    And the calendar day "Wednesday" lists 1 planned workout
