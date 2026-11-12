@ui @training @structured-workouts @fake-timers
Feature: Phase 6: from the next workout through the briefing to a ride the workout drives
  The vertical use case of phase 6 (structured-workouts.md, section 13): "Next workout" on Today
  leads to the briefing with the workout fixed; the rider chooses a route and starts, with the
  arrow keys, Enter and Back only. ERG then follows the workout with its targets resolved at the
  start (FTP 250 W: 50 % is 125 W, 90 % is 225 W), the HUD widget shows it, and a replay of the
  recorded ride gives the same targets and steps at the same times.

  Here intervals.icu, the browser and the secret store are simulated. It is Wednesday 4 November
  2026.

  Background:
    Given the ridrs plugins "activity-session, recording-session, workout-player, control-erg, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-briefing, ui-route-profile, ui-activity-screen, ui-hud, ui-widget-workout, ui-workout-chart, ui-settings, ui-area-me, profile-local, planner-intervals-icu, ui-training-plan" together with the simulated intervals.icu
    And the briefing fixture routes are installed
    And a test device plugin "test-device"
    And intervals.icu knows the athlete "Alex Rider" with an FTP of 250 W and a weight of 72 kg
    And the athlete profile on this device holds an FTP of 250 W and a weight of 72 kg
    And the local time is "2026-11-04 08:00"
    And the secret store holds a token for intervals.icu

  Scenario: Next workout, briefing, route, ride: ERG follows the workout, the HUD shows it, a replay agrees
    Given intervals.icu plans "Sweet Spot 3x12" on "2026-11-04" with the steps:
      | step     | duration | power  |
      | warmup   | 1m       | 50-75% |
      | repeat   | 2x       |        |
      | -        | 1m       | 90%    |
      | -        | 30s      | 55%    |
      | cooldown | 1m       | 60-40% |
    And the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I move the focus to "Next workout: Sweet Spot 3x12, Today"
    And I press Enter
    Then the briefing does not ask for the workout
    When I move the focus to "Short loop"
    And I press Enter
    And I press Enter
    Then the latest ride request carries the workout "Sweet Spot 3x12"
    And the latest ride request names the planned entry of "intervals.icu"
    And the workout HUD shows the name "Sweet Spot 3x12"
    When "test-device" delivers only power 200 W every 0.25 s for 70 seconds
    Then the workout's target power was:
      | at     | target |
      | +0 s   | 125 W  |
      | +30 s  | 157 W  |
      | +60 s  | 225 W  |
    And the workout HUD shows the set "1/2"
    When I press "Finish ride"
    And the recording is replayed
    Then the replay is identical
    And the replay compared every "trainer.target-power" event of the ride, and there was at least one
    And the replay compared every "workout.step-changed" event of the ride, and there was at least one
