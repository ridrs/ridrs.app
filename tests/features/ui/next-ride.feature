@ui @training
Feature: The next ride is prepared in the menu
  Under the entries of the main menu the rider prepares the next ride (ADR 0096): a workout dragged
  from the Training area and a route dragged from the Ride page are dropped onto it, and it is kept
  across a restart. "Start next ride" opens the briefing with both fixed. A ride that finishes
  with everything the next ride holds clears it; another ride leaves it.

  Here the routes are fixtures. It is Wednesday 4 November 2026.

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-activity-screen, ui-briefing, ui-route-profile, ui-workout-chart, ui-area-ride, ui-landscape-demo, ui-area-training, library-ridrs, profile-local, ui-settings, ui-next-ride" together with a test device plugin "test-device"
    And the briefing fixture routes are installed
    And the local time is "2026-11-04 08:00"
    And the athlete profile on this device holds an FTP of 250 W and a weight of 72 kg
    And the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown

  Scenario: The next ride is empty at first and cannot be started
    Then the next ride holds no workout
    And the next ride holds no route
    And the button "Start next ride" is disabled

  Scenario: A workout and a route dropped onto the next ride are kept across a restart
    When I press "Training"
    And I drag the workout "Sweet Spot 3×12" onto the next ride
    Then the next ride holds the workout "Sweet Spot 3×12"
    When I press "Ride"
    And I drag the route "Short loop" onto the next ride
    Then the next ride holds the route "Short loop"
    When ridrs restarted
    And I reload the UI
    Then the next ride holds the workout "Sweet Spot 3×12"
    And the next ride holds the route "Short loop"

  Scenario: A planned workout can be the next ride's workout
    When I press "Training"
    And I drag the planned workout "VO2 Max 5×4" onto the next ride
    Then the next ride holds the workout "VO2 Max 5×4"

  Scenario: A workout dropped again takes the place of the first
    When I press "Training"
    And I drag the workout "Sweet Spot 3×12" onto the next ride
    And I drag the workout "Gentle Waves" onto the next ride
    Then the next ride holds the workout "Gentle Waves"

  Scenario: A workout is taken out of the next ride
    When I press "Training"
    And I drag the workout "Sweet Spot 3×12" onto the next ride
    And I press "Remove the workout from the next ride"
    Then the next ride holds no workout

  Scenario: Start next ride opens the briefing with both fixed, and the finished ride clears it
    When I press "Training"
    And I drag the workout "Sweet Spot 3×12" onto the next ride
    And I press "Ride"
    And I drag the route "Short loop" onto the next ride
    Then the next ride holds the route "Short loop"
    When I press "Start next ride"
    Then the "briefing" screen is shown
    And the briefing shows the workout "Sweet Spot 3×12"
    And the briefing marks the workout as fixed
    And the briefing shows the route "Short loop"
    And the briefing marks the route as fixed
    When I start the ride in the briefing
    Then 1 ride was requested
    And the latest ride request names the route "short-loop"
    And the latest ride request carries the workout "Sweet Spot 3×12"
    When I press "Finish ride"
    Then the next ride holds no workout
    And the next ride holds no route

  Scenario: A ride with another workout leaves the next ride
    When I press "Training"
    And I drag the workout "Sweet Spot 3×12" onto the next ride
    And I press "Today"
    And I press "Start ride"
    And I move the focus to "Short loop"
    And I press Enter
    And I move the focus to "No workout"
    And I press Enter
    And I start the ride in the briefing
    And I press "Finish ride"
    Then the next ride holds the workout "Sweet Spot 3×12"

  Scenario: The narrow menu has no next ride
    Given the main screen is 600 px wide
    Then the menu shows no next ride

  Scenario: The next ride speaks German
    When I press "Settings"
    And I press "Deutsch"
    And I press "Schließen"
    Then the next ride reads "Nächste Fahrt"
    And the next ride reads "Workout hier ablegen"
