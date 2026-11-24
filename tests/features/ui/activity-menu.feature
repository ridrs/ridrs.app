@ui @training @structured-workouts @fake-timers
Feature: Loading and switching workouts and routes in the activity menu
  During a ride the rider opens the activity menu with Menu to load a workout into a free ride,
  switch to another workout, clear the active workout, or switch to another downloaded route
  (ADR 0108). Every choice enters the simulation bus as a ride input, so the HUD and trainer targets
  follow at once and a replay of the recorded ride reproduces the exact targets and states.

  Here intervals.icu, the browser and the secret store are simulated. It is Wednesday 4 November
  2026.

  Background:
    Given the ridrs plugins "activity-session, recording-session, export-fit, workout-player, control-erg, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-briefing, ui-route-profile, ui-activity-screen, ui-debriefing, ui-hud, ui-widget-workout, ui-workout-chart, ui-settings, ui-area-me, profile-local, planner-intervals-icu, ui-training-plan" together with the simulated intervals.icu
    And the briefing fixture routes are installed
    And a test device plugin "test-device"
    And intervals.icu knows the athlete "Alex Rider" with an FTP of 250 W and a weight of 72 kg
    And the athlete profile on this device holds an FTP of 250 W and a weight of 72 kg
    And the local time is "2026-11-04 08:00"
    And the secret store holds a token for intervals.icu

  Scenario: Loading, switching and clearing a workout from the activity menu, verified on replay
    Given intervals.icu plans "Sweet Spot 2x5" on "2026-11-04" with the steps:
      | step     | duration | power |
      | warmup   | 1m       | 50%   |
      | interval | 1m       | 90%   |
    And intervals.icu also plans "Tempo Spin" on "2026-11-05" with the steps:
      | step     | duration | power |
      | interval | 2m       | 80%   |
    And the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Start ride"
    And I start a free ride in the briefing
    And "test-device" delivers only power 200 W every 0.25 s for 10 seconds
    And I press "Menu"
    Then the debriefing shows "No workout"
    And the debriefing offers "Load workout"
    When I press "Load workout"
    And I press "Sweet Spot 2x5"
    Then the debriefing shows "Sweet Spot 2x5"
    And the debriefing offers "Change workout"
    When I press "Continue ride"
    Then the workout HUD shows the name "Sweet Spot 2x5"
    And the latest target power is 125 W
    When "test-device" delivers only power 200 W every 0.25 s for 65 seconds
    Then the workout HUD shows the segment "2/2"
    And the latest target power is 225 W
    When I press "Menu"
    And I press "Change workout"
    And I press "Tempo Spin"
    And I press "Continue ride"
    Then the workout HUD shows the name "Tempo Spin"
    And the workout HUD shows the segment "1/1"
    And the latest target power is 200 W
    When I press "Menu"
    And I press "Change workout"
    And I press "No workout"
    And I press "Continue ride"
    Then the workout HUD is not shown
    And the latest target power is off
    When I press "Menu"
    And I press "Finish ride"
    And I press "Save"
    And the recording is replayed
    Then the replay is identical
    And the replay compared every "trainer.target-power" event of the ride, and there was at least one
    And the replay compared every "workout.step-changed" event of the ride, and there was at least one

  Scenario: Switching to another route and back to a free ride from the activity menu
    Given the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Start ride"
    And I start a free ride in the briefing
    And I press "Menu"
    Then the debriefing shows "Free ride"
    And the debriefing offers "Change route"
    When I press "Change route"
    Then the route choice "Not here yet" in the activity menu is disabled
    When I press "Short loop"
    Then the debriefing shows "Short loop"
    When I press "Continue ride"
    Then the ride takes place on the landscape "fixture-briefing/landscape" along the route "short-loop"
    When I press "Menu"
    And I press "Change route"
    And I press "Long coast"
    And I press "Continue ride"
    Then the ride takes place on the landscape "fixture-briefing/landscape" along the route "long-coast"
    When I press "Menu"
    And I press "Change route"
    And I press "Free ride"
    And I press "Continue ride"
    Then the ride has no world
    When I press "Menu"
    And I press "Finish ride"
    And I press "Save"
    And the recording is replayed
    Then the replay is identical

  Scenario: The activity menu and the delete confirmation speak German
    Given the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Settings"
    And I press "Deutsch"
    And I press "Schließen"
    And I press "Fahrt starten"
    And I press "Freie Fahrt"
    And I press "Kein Workout"
    And I press "Starten"
    And I press "Menu"
    Then the debriefing shows "Aktivitätsmenü"
    And the debriefing offers "Weiterfahren", "Fahrt beenden", "Workout laden" and "Strecke wechseln"
    When I press "Fahrt beenden"
    Then the debriefing shows "Fahrt beendet"
    And the debriefing offers "Speichern" and "Löschen"
    When I press "Löschen"
    Then the debriefing shows "Bist du sicher?"
    And the debriefing offers "Ja" and "Nein"
