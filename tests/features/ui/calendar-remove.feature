@ui @training
Feature: A planned workout is removed by dragging it into the bin
  A planned workout is moved by dragging it onto another day. While one is dragged, a bin appears
  at the bottom of the screen: a workout dropped there is removed from the calendar. Like a move,
  the removal is sent to the calendar at once; the workout is gone at once and comes back with the
  reason when the calendar refuses it. Workouts of the library are not in the calendar, so
  dragging one shows no bin.

  Here intervals.icu, the browser and the secret store are simulated. It is Wednesday 4 November
  2026.

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-settings, ui-area-training, library-ridrs, ui-area-me, profile-local, planner-intervals-icu, ui-training-plan" together with the simulated intervals.icu
    And a test device plugin "test-device"
    And intervals.icu knows the athlete "Alex Rider" with an FTP of 250 W and a weight of 72 kg
    And intervals.icu has the library:
      | folder | name            | type | duration | load |
      | Base   | Sweet Spot 3x12 | Ride | 1h15m    | 78   |
    And intervals.icu plans:
      | date       | type | name         | duration | load |
      | 2026-11-05 | Ride | Threshold 20 | 1h       | 80   |
    And the local time is "2026-11-04 08:00"
    And the main screen is 1400 px wide

  Scenario: The bin is shown only while a planned workout is dragged
    Given the secret store holds a token for intervals.icu
    And the host has started
    And the ridrs UI is shown
    When I press "Training"
    Then the page shows no bin
    When I start dragging the planned workout "Threshold 20"
    Then the page shows the bin "Drop here to remove"
    When I end the drag
    Then the page shows no bin
    When I start dragging the workout "Sweet Spot 3x12"
    Then the page shows no bin

  Scenario: A workout dropped into the bin is removed from intervals.icu
    Given the secret store holds a token for intervals.icu
    And the host has started
    And the ridrs UI is shown
    And the simulated intervals.icu forgets the requests so far
    When I press "Training"
    And I drag the planned workout "Threshold 20" into the bin
    Then intervals.icu received 1 requests "DELETE /api/v1/athlete/0/events/*"
    And the calendar day "Thursday" lists no "Threshold 20"
    And the page shows no bin

  Scenario: A refused removal is taken back and says why
    Given the secret store holds a token for intervals.icu
    And the host has started
    And the ridrs UI is shown
    And intervals.icu cannot be reached for writes
    When I press "Training"
    And I drag the planned workout "Threshold 20" into the bin
    Then the page says "intervals.icu could not be reached: nothing was removed."
    And the calendar day "Thursday" lists "Threshold 20"

  Scenario: A workout of the calendar of ridrs is removed and stays removed
    Given the host has started
    And the ridrs UI is shown
    When I press "Training"
    And I drag the planned workout "VO2 Max 5×4" into the bin
    Then the calendar day "Thursday" lists no "VO2 Max 5×4"
    When ridrs restarted
    And I reload the UI
    And I press "Training"
    Then the calendar day "Thursday" lists no "VO2 Max 5×4"

  Scenario: The bin speaks German
    Given the secret store holds a token for intervals.icu
    And the host has started
    And the ridrs UI is shown
    When I press "Settings"
    And I press "Deutsch"
    And I press "Schließen"
    And I press "Training"
    And I start dragging the planned workout "Threshold 20"
    Then the page shows the bin "Zum Entfernen hier ablegen"
