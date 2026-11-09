@ui @training @draft
Feature: The Training area saves the changes of an external calendar once
  Planning and moving workouts in a calendar behind an external API costs a request each
  (ADR 0078). So they are collected in a list of open changes on the page ("3 changes open") with
  one "Save" and a "Discard", and Save sends them one after another, at least 250 ms apart.
  Back with open changes does not throw them away and sends nothing: it moves the focus to "Save".
  The calendar of ridrs on this device keeps its changes at once.

  Here intervals.icu, the browser and the secret store are simulated. It is Wednesday 4 November
  2026.

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-settings, ui-area-training, ui-area-me, profile-local, planner-intervals-icu, ui-training-plan" together with the simulated intervals.icu
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

  Scenario: Changes are collected and sent with one save
    When I press "Training"
    And I drag the workout "Sweet Spot 3x12" onto "Friday"
    And I drag the workout "Sweet Spot 3x12" onto "Saturday"
    And I drag the planned workout "Threshold 20" onto "Sunday"
    Then the page says "3 changes open"
    And the calendar day "Friday" lists "Sweet Spot 3x12"
    And the calendar day "Friday" lists "Not saved yet"
    And intervals.icu received 0 requests "POST *"
    And intervals.icu received 0 requests "PUT *"
    When I press "Save"
    Then intervals.icu received 2 requests "POST /api/v1/athlete/0/events"
    And intervals.icu received 1 requests "PUT /api/v1/athlete/0/events/*"
    And the page says "Sweet Spot 3x12"
    And the page offers no "Save" button

  Scenario: The writes of a save are at least 250 ms apart
    Given the requests to intervals.icu are paced as in the app
    When I press "Training"
    And I drag the workout "Sweet Spot 3x12" onto "Friday"
    And I drag the workout "Sweet Spot 3x12" onto "Saturday"
    And I drag the planned workout "Threshold 20" onto "Sunday"
    And I press "Save"
    Then intervals.icu received 2 requests "POST *"
    And intervals.icu received 1 requests "PUT *"
    And the writes reached intervals.icu at least 250 ms apart

  Scenario: Discard sends nothing and takes the changes back
    When I press "Training"
    And I drag the workout "Sweet Spot 3x12" onto "Friday"
    And I press "Discard"
    Then the calendar day "Friday" lists no "Sweet Spot 3x12"
    And the page offers no "Save" button
    And intervals.icu received 0 requests "POST *"

  Scenario: Back with open changes sends nothing and moves the focus to Save
    When I press "Training"
    And I drag the workout "Sweet Spot 3x12" onto "Friday"
    And I press Back
    Then the "training" screen is shown
    And the focus is on "Save"
    And the page says "1 change open"
    And intervals.icu received 0 requests "POST *"

  Scenario: A refused save keeps the changes and says why
    Given intervals.icu cannot be reached for writes
    When I press "Training"
    And I drag the workout "Sweet Spot 3x12" onto "Friday"
    And I press "Save"
    Then the page says "intervals.icu could not be reached: nothing was planned."
    And the page says "1 change open"
    When intervals.icu can be reached for writes
    And the simulated intervals.icu forgets the requests so far
    And I press "Save"
    Then intervals.icu received 1 requests "POST /api/v1/athlete/0/events"
    And the page offers no "Save" button
