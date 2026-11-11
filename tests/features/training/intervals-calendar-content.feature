@training
Feature: A workout of another library is planned in intervals.icu with its content
  When intervals.icu is the calendar, a workout of another library (the built-in workouts of
  ridrs) is created there with its whole content (structured-workouts.md, section 10), as
  intervals.icu text in the description (the default) or as a workout document. The planned entry
  remembers its library workout. When that workout changes, its future entries that were not
  ridden follow by `PUT`, without a question; ridden and past entries stay as they are. An entry
  changed in intervals.icu keeps that change and no longer follows: ridrs never silently
  overwrites it. Before following, the planned workouts are read again once (ADR 0078).

  Here intervals.icu, the browser and the secret store are simulated, and a test library plays
  the library of ridrs. It is Wednesday 4 November 2026.

  Background:
    Given the ridrs plugins "planner-intervals-icu" together with the simulated intervals.icu
    And a test library plays the library of "ridrs"
    And intervals.icu knows the athlete "Alex Rider" with an FTP of 250 W and a weight of 72 kg
    And the local time is "2026-11-04 08:00"
    And the secret store holds a token for intervals.icu
    And the library of "ridrs" has the workout "sweet-spot" named "Sweet Spot 3x12" in the intervals.icu text:
      """
      - Warm up 10m ramp 50-75%

      3x
      - 12m 90% 90rpm
      - 4m 55%

      - 5m ramp 65-45%
      """

  Scenario: A built-in workout arrives in intervals.icu with its content in the description
    Given the host has started
    When the rider plans the workout "sweet-spot" of "ridrs" on "2026-11-05" in the calendar of "intervals.icu"
    Then intervals.icu received "POST /api/v1/athlete/0/events" with the body:
      | category         | WORKOUT             |
      | start_date_local | 2026-11-05T00:00:00 |
      | type             | Ride                |
      | name             | Sweet Spot 3x12     |
    And the event created in intervals.icu has the description:
      """
      - Warm up 10m ramp 50-75%

      3x
      - 12m 90% 90rpm
      - 4m 55%

      - 5m ramp 65-45%
      """
    And the event created in intervals.icu has no workout document
    And the planned workout on "2026-11-05" of "intervals.icu" follows the workout "sweet-spot" of "ridrs"
    And the planned workout on "2026-11-05" of "intervals.icu" has the steps of the workout "sweet-spot" of "ridrs"
    When the plan of "intervals.icu" is refreshed
    Then the planned workout on "2026-11-05" of "intervals.icu" follows the workout "sweet-spot" of "ridrs"

  Scenario: Switched to workout documents, the content goes as a workout document
    Given the planner sends the workout content to intervals.icu as a workout document
    And the host has started
    When the rider plans the workout "sweet-spot" of "ridrs" on "2026-11-05" in the calendar of "intervals.icu"
    Then the event created in intervals.icu has the workout document:
      """
      {
        "steps": [
          { "text": "Warm up", "duration": 600, "ramp": true, "power": { "units": "%ftp", "start": 50, "end": 75 } },
          { "reps": 3, "text": "3x", "steps": [
            { "duration": 720, "power": { "units": "%ftp", "value": 90 }, "cadence": { "units": "rpm", "value": 90 } },
            { "duration": 240, "power": { "units": "%ftp", "value": 55 } }
          ] },
          { "duration": 300, "ramp": true, "power": { "units": "%ftp", "start": 65, "end": 45 } }
        ]
      }
      """
    And the planned workout on "2026-11-05" of "intervals.icu" follows the workout "sweet-spot" of "ridrs"

  Scenario: A changed library workout updates its future entry, not the ridden or the past one
    Given intervals.icu has done:
      | date       | type | name            | duration | load |
      | 2026-11-04 | Ride | Sweet Spot 3x12 | 1h       | 70   |
    And the host has started
    And the rider plans the workout "sweet-spot" of "ridrs" on "2026-11-03" in the calendar of "intervals.icu"
    And the rider plans the workout "sweet-spot" of "ridrs" on "2026-11-04" in the calendar of "intervals.icu"
    And the rider plans the workout "sweet-spot" of "ridrs" on "2026-11-06" in the calendar of "intervals.icu"
    When the workout "sweet-spot" of "ridrs" changes to the intervals.icu text:
      """
      - Warm up 10m ramp 50-75%

      4x
      - 12m 92% 90rpm
      - 4m 55%
      """
    Then intervals.icu received "PUT" for the event on "2026-11-06" with the description:
      """
      - Warm up 10m ramp 50-75%

      4x
      - 12m 92% 90rpm
      - 4m 55%
      """
    And intervals.icu received no "PUT" for the event on "2026-11-04"
    And intervals.icu received no "PUT" for the event on "2026-11-03"
    And the planned workout on "2026-11-06" of "intervals.icu" has the steps of the workout "sweet-spot" of "ridrs"
    And the planned workout on "2026-11-06" of "intervals.icu" follows the workout "sweet-spot" of "ridrs"

  Scenario: An entry changed in intervals.icu keeps its change and no longer follows
    Given the host has started
    And the rider plans the workout "sweet-spot" of "ridrs" on "2026-11-06" in the calendar of "intervals.icu"
    When the event on "2026-11-06" is changed in intervals.icu to the description "- 20m 60%"
    And the workout "sweet-spot" of "ridrs" changes to the intervals.icu text:
      """
      - 30m 70%
      """
    Then intervals.icu received no "PUT" for the event on "2026-11-06"
    And the planned workout on "2026-11-06" of "intervals.icu" follows no library workout
    And the planned workout on "2026-11-06" of "intervals.icu" has the description "- 20m 60%"

  Scenario: A library workout published again unchanged sends nothing
    Given the host has started
    And the rider plans the workout "sweet-spot" of "ridrs" on "2026-11-06" in the calendar of "intervals.icu"
    And the simulated intervals.icu forgets the requests so far
    When the library of "ridrs" is published again unchanged
    Then intervals.icu received 0 requests
