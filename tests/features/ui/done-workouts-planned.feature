@ui @training
Feature: A ride done from a planned entry is listed as that plan's ride
  A ride saved with the workout that was ridden also names the planned entry it came from. The
  calendar pairs the ride with that entry first, before it looks at names, durations and loads
  (ADR 0076), so the plan is done "as planned" even when it was renamed meanwhile (saving the ride
  loads the plan again).

  Here intervals.icu, the browser and the secret store are simulated. It is Wednesday 4 November
  2026.

  Background:
    Given the ridrs plugins "activity-session, recording-session, export-fit, history-ridrs, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-briefing, ui-route-profile, ui-activity-screen, ui-debriefing, ui-settings, ui-area-training, ui-area-me, profile-local, planner-intervals-icu, ui-training-plan" together with the simulated intervals.icu
    And the briefing fixture routes are installed
    And a test device plugin "test-device"
    And intervals.icu knows the athlete "Alex Rider" with an FTP of 250 W and a weight of 72 kg
    And the athlete profile on this device holds an FTP of 250 W and a weight of 72 kg
    And the local time is "2026-11-04 08:00"
    And the secret store holds a token for intervals.icu

  Scenario: A ride of a planned entry is the plan's ride although the plan has another name now
    Given intervals.icu plans "Sweet Spot 3x12" on "2026-11-04" with the steps:
      | step     | duration | power  |
      | warmup   | 10m      | 50-75% |
      | repeat   | 3x       |        |
      | -        | 12m      | 90%    |
      | -        | 4m       | 55%    |
      | cooldown | 5m       | 60-40% |
    And the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I move the focus to "Next workout: Sweet Spot 3x12, Today"
    And I press Enter
    And I move the focus to "Short loop"
    And I press Enter
    And I press Enter
    And intervals.icu renames the plan "Sweet Spot 3x12" to "Tuesday intervals"
    And I press "Finish ride"
    And I press "Save"
    Then the "main" screen is shown
    When I press "Training"
    Then the calendar day "Wednesday" shows "Sweet Spot 3x12" as done as planned
    And the calendar day "Wednesday" lists 0 planned workouts
