@ui @training @budget
Feature: The reads and writes to intervals.icu keep to a budget
  intervals.icu limits the requests of an app (ADR 0078). What was read stays valid for a while:
  the athlete and today's weight for an hour, the planned workouts and the rides done for 15
  minutes, the library for a day and only once the library is shown. A start with a valid cache
  sends nothing; a stale cache is shown at once and read again in the background. Nothing reloads
  on a timer or when the window gets the focus, and the refresh button reads at most once a
  minute. A change that equals what the profile or the calendar already holds is not sent. When
  intervals.icu answers 429, ridrs stops sending until the time it named has passed.

  Here intervals.icu, the browser and the secret store are simulated. It is Wednesday 4 November
  2026.

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-settings, ui-area-training, ui-area-me, profile-local, planner-intervals-icu, ui-training-plan" together with the simulated intervals.icu
    And a test device plugin "test-device"
    And intervals.icu knows the athlete "Alex Rider" with an FTP of 250 W and a weight of 72 kg
    And intervals.icu has the library:
      | folder | name            | type | duration | load |
      | Base   | Sweet Spot 3x12 | Ride | 1h15m    | 78   |
    And the local time is "2026-11-04 08:00"
    And the secret store holds a token for intervals.icu

  Scenario: Without a cache a start reads the athlete and the plan, and not the library
    Given the host has started
    Then intervals.icu received 4 requests
    And intervals.icu received 1 requests "GET /api/v1/athlete/0"
    And intervals.icu received 1 requests "GET /api/v1/athlete/0/wellness/*"
    And intervals.icu received 1 requests "GET /api/v1/athlete/0/events"
    And intervals.icu received 1 requests "GET /api/v1/athlete/0/activities"
    And intervals.icu received 0 requests "GET /api/v1/athlete/0/workouts"

  Scenario: A valid cache costs no request at start
    Given the plan cache of intervals.icu was read 5 minutes ago and plans "Endurance" on "2026-11-04"
    And the host has started
    And the ridrs UI is shown
    Then the next workout card shows:
      | name | Endurance |
    And intervals.icu received 0 requests

  Scenario: A stale cache is shown at once and read again in the background
    Given the plan cache of intervals.icu was read 90 minutes ago and plans "Endurance" on "2026-11-04"
    And intervals.icu holds back its answers to reads
    And the host has started
    And the ridrs UI is shown
    Then the next workout card shows:
      | name | Endurance |
    When intervals.icu answers its reads
    Then intervals.icu received 4 requests

  Scenario: Only the stale resource is read: the athlete stays valid for an hour, the plan for 15 minutes
    Given the plan cache of intervals.icu was read 20 minutes ago and plans "Endurance" on "2026-11-04"
    And the host has started
    Then intervals.icu received 2 requests
    And intervals.icu received 1 requests "GET /api/v1/athlete/0/events"
    And intervals.icu received 1 requests "GET /api/v1/athlete/0/activities"
    And intervals.icu received 0 requests "GET /api/v1/athlete/0"

  Scenario: A cache from before the times of its resources is stale
    Given the plan cache of intervals.icu is from before its resources had times and plans "Endurance" on "2026-11-04"
    And the host has started
    Then intervals.icu received 4 requests

  Scenario: The library is read when it is shown, and again only after a day
    Given the plan cache of intervals.icu was read 5 minutes ago and plans "Endurance" on "2026-11-04"
    And the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    Then intervals.icu received 0 requests
    When I press "Training"
    Then the library lists the workout "Sweet Spot 3x12" of "intervals.icu"
    And intervals.icu received 2 requests
    And intervals.icu received 1 requests "GET /api/v1/athlete/0/workouts"
    And intervals.icu received 1 requests "GET /api/v1/athlete/0/folders"
    When I press Back
    And I press "Training"
    Then intervals.icu received 2 requests
    When the local time is "2026-11-05 09:00"
    And the library of "intervals.icu" is asked for
    Then intervals.icu received 4 requests

  Scenario: The refresh reads the athlete and the plan, at most once a minute
    Given the host has started
    And the simulated intervals.icu forgets the requests so far
    When the plan of "intervals.icu" is refreshed
    Then intervals.icu received 4 requests
    When the plan of "intervals.icu" is refreshed
    Then intervals.icu received 4 requests
    When the local time is "2026-11-04 08:02"
    And the plan of "intervals.icu" is refreshed
    Then intervals.icu received 8 requests
    And intervals.icu received 0 requests "GET /api/v1/athlete/0/workouts"

  Scenario: A saved ride reads only the plan, not the athlete
    Given the host has started
    And the simulated intervals.icu forgets the requests so far
    When a ride is saved
    Then intervals.icu received 2 requests
    And intervals.icu received 1 requests "GET /api/v1/athlete/0/events"
    And intervals.icu received 1 requests "GET /api/v1/athlete/0/activities"
    And intervals.icu received 0 requests "GET /api/v1/athlete/0"

  Scenario: A change to the values the profile already has is sent nowhere
    Given the host has started
    And the simulated intervals.icu forgets the requests so far
    When the rider asks the athlete profile of "intervals.icu" to change to an FTP of 250 W and a weight of 72 kg
    Then intervals.icu received no write
    And intervals.icu received 0 requests

  Scenario: Only the changed field of the profile is sent
    Given the host has started
    And the simulated intervals.icu forgets the requests so far
    When the rider asks the athlete profile of "intervals.icu" to change to an FTP of 250 W and a weight of 73 kg
    Then intervals.icu received 1 requests "PUT /api/v1/athlete/0/wellness/*"
    And intervals.icu received 0 requests "PUT /api/v1/athlete/0/sport-settings/Ride"

  Scenario: A workout moved to the day it is on is sent nowhere
    Given intervals.icu plans:
      | date       | name      | duration | load |
      | 2026-11-06 | Endurance | 1h       | 50   |
    And the host has started
    And the simulated intervals.icu forgets the requests so far
    When the rider moves the planned workout "Endurance" of "intervals.icu" to "2026-11-06"
    Then intervals.icu received no write
    And intervals.icu received 0 requests

  Scenario: Too many requests stop everything until the time intervals.icu named has passed
    Given intervals.icu asks for 120 seconds of rest
    And the host has started
    Then the account of "intervals.icu" is "failed" because "rate-limited"
    And intervals.icu received 1 requests
    When the local time is "2026-11-04 08:01"
    And the plan of "intervals.icu" is refreshed
    Then intervals.icu received 1 requests
    When intervals.icu no longer asks for rest
    And the local time is "2026-11-04 08:03"
    And the plan of "intervals.icu" is refreshed
    Then the account of "intervals.icu" is "connected"
    And intervals.icu received 5 requests

  Scenario: The rider is told that intervals.icu asked for a pause
    Given intervals.icu asks for 120 seconds of rest
    And the host has started
    And the ridrs UI is shown
    Then the training tile shows "intervals.icu asks for a pause: too many requests."

  Scenario: The refresh button rests for a minute
    Given the host has started
    And the ridrs UI is shown
    When I open the next workout
    And I press "Refresh"
    Then the button "Refresh" is disabled
