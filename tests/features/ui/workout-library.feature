@ui @training
Feature: The workout library lists the workouts of every provider
  The workout library is read from every provider at once (ADR 0075), without a choice. The
  settings page has a row "Workout library" that lists the providers, read only. The Training
  area lists their workouts, grouped by provider. ridrs on this device has no workouts of its own
  yet; intervals.icu offers its library, with the folder or plan of each workout. Runs and other
  sports are left out. A token without the scope of the library leaves the library unavailable
  and the rest working.

  Here intervals.icu, the browser and the secret store are simulated.

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-settings, ui-area-training, library-ridrs, ui-area-me, profile-local, planner-intervals-icu, ui-training-plan" together with the simulated intervals.icu
    And a test device plugin "test-device"
    And intervals.icu knows the athlete "Alex Rider" with an FTP of 250 W and a weight of 72 kg
    And intervals.icu has the library:
      | folder | name            | type | duration | load |
      | Base   | Sweet Spot 3x12 | Ride | 1h15m    | 78   |
      | Base   | Endurance 90    | Ride | 1h30m    | 65   |
      | -      | Tempo 40        | Ride | 40m      | 60   |
      | Base   | Easy Run        | Run  | 40m      | 30   |
    And the local time is "2026-11-04 08:00"
    And the secret store holds a token for intervals.icu

  Scenario: Settings lists the providers of the library
    Given the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Settings"
    Then the row "Workout library" lists "ridrs (this device), intervals.icu"
    And the page says "all providers, read only"

  Scenario: The library is read when the Training area shows it, not at start (ADR 0078)
    Given the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    Then intervals.icu received 0 requests "GET /api/v1/athlete/0/workouts"
    When I press "Training"
    Then intervals.icu received "GET /api/v1/athlete/0/workouts" with the token
    And intervals.icu received "GET /api/v1/athlete/0/folders" with the token

  Scenario: The Training area lists the workouts of intervals.icu with their folders
    Given the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Training"
    Then the library lists these workouts of "intervals.icu":
      | name            | details                  |
      | Tempo 40        | 40 min · 60 TSS          |
      | Endurance 90    | Base · 90 min · 65 TSS   |
      | Sweet Spot 3x12 | Base · 75 min · 78 TSS   |
    And the library lists no workouts of "ridrs"

  Scenario: Without the scope of the library it is unavailable and the rest works
    Given intervals.icu lacks the scope of the library
    And the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Settings"
    Then the row "Athlete profile" has "intervals.icu" chosen
    And the row "Athlete profile" shows a status starting with "Ready"
    When I press Back
    And I press "Training"
    Then the library lists no workouts of "intervals.icu"
    And the page says "Your sources have no workouts yet."

  Scenario: Offline, the last library stands in
    Given the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Training"
    Then the library lists the workout "Tempo 40" of "intervals.icu"
    When I press Back
    And the local time is "2026-11-05 09:30"
    And the host is restarted while intervals.icu is unreachable
    And I reload the UI
    And I press "Training"
    Then the library lists these workouts of "intervals.icu":
      | name            | details                |
      | Tempo 40        | 40 min · 60 TSS        |
      | Endurance 90    | Base · 90 min · 65 TSS |
      | Sweet Spot 3x12 | Base · 75 min · 78 TSS |

  Scenario: Disconnecting empties the library
    Given the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Training"
    Then the library lists these workouts of "intervals.icu":
      | name            | details                |
      | Tempo 40        | 40 min · 60 TSS        |
      | Endurance 90    | Base · 90 min · 65 TSS |
      | Sweet Spot 3x12 | Base · 75 min · 78 TSS |
    When I press Back
    And I press "Profile"
    And I press "Disconnect intervals.icu"
    And I press Back
    And I press "Training"
    Then the library lists no workouts of "intervals.icu"

  Scenario: The library is in German
    Given the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Settings"
    And I press "Deutsch"
    Then the row "Trainingsbibliothek" lists "ridrs (dieses Gerät), intervals.icu"
    And the page says "alle Anbieter, nur lesbar"
