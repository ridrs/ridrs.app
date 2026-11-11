@ui @training
Feature: The Training area sends a change of an external calendar at once
  Planning and moving workouts in a calendar behind an external API is a request each. The rider
  sees the result of a drop, so the change is sent when the workout is dropped: shown at once as
  "Saving…" until the calendar has it, taken back with the reason when the calendar refuses it.
  Unlike the athlete profile (ADR 0078), the calendar has no Save and no Discard.

  Here intervals.icu, the browser and the secret store are simulated. It is Wednesday 4 November
  2026.

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-settings, ui-area-training, library-ridrs, ui-area-me, profile-local, planner-intervals-icu, ui-training-plan" together with the simulated intervals.icu
    And a test device plugin "test-device"
    And intervals.icu knows the athlete "Alex Rider" with an FTP of 250 W and a weight of 72 kg
    And intervals.icu has the library:
      | folder | name            | type | duration | load |
      | Base   | Sweet Spot 3x12 | Ride | 1h15m    | 78   |
    And the library workout "Sweet Spot 3x12" of intervals.icu has the steps:
      | step     | duration | power  |
      | warmup   | 10m      | 50-75% |
      | cooldown | 5m       | 60-40% |
    And intervals.icu plans:
      | date       | type | name         | duration | load |
      | 2026-11-05 | Ride | Threshold 20 | 1h       | 80   |
    And the local time is "2026-11-04 08:00"
    And the secret store holds a token for intervals.icu
    And the host has started
    And the athlete profile of "intervals.icu" is in use
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    And the simulated intervals.icu forgets the requests so far

  Scenario: Every drop is sent at once and the page offers no Save
    When I press "Training"
    And I drag the workout "Sweet Spot 3x12" onto "Friday"
    And I drag the workout "Sweet Spot 3x12" onto "Saturday"
    And I drag the planned workout "Threshold 20" onto "Sunday"
    Then intervals.icu received 2 requests "POST /api/v1/athlete/0/events"
    And intervals.icu received 1 requests "PUT /api/v1/athlete/0/events/*"
    And the calendar day "Friday" lists "Sweet Spot 3x12"
    And the page offers no "Save" button
    And the page offers no "Discard" button

  Scenario: The writes are at least 250 ms apart
    Given the requests to intervals.icu are paced as in the app
    When I press "Training"
    And I drag the workout "Sweet Spot 3x12" onto "Friday"
    And I drag the workout "Sweet Spot 3x12" onto "Saturday"
    And I drag the planned workout "Threshold 20" onto "Sunday"
    Then intervals.icu received 2 requests "POST *"
    And intervals.icu received 1 requests "PUT *"
    And the writes reached intervals.icu at least 250 ms apart

  Scenario: A moved workout can be moved again
    When I press "Training"
    And I drag the planned workout "Threshold 20" onto "Saturday"
    And I drag the planned workout "Threshold 20" onto "Sunday"
    Then intervals.icu received 2 requests "PUT /api/v1/athlete/0/events/*"
    And the calendar day "Sunday" lists "Threshold 20"

  Scenario: A refused change is taken back and says why
    Given intervals.icu cannot be reached for writes
    When I press "Training"
    And I drag the workout "Sweet Spot 3x12" onto "Friday"
    Then the page says "intervals.icu could not be reached: nothing was planned."
    And the calendar day "Friday" lists no "Sweet Spot 3x12"
