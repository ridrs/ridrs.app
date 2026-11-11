@ui @training
Feature: A library workout is planned on a day in the chosen calendar
  "Plan on a day" puts a workout of the library, with its steps, on a day of the chosen calendar
  (ADR 0075): in intervals.icu it is an event created with its steps, and a planned workout can be
  moved to another day or removed again. A write is refused, never queued: when intervals.icu
  cannot be reached nothing changes, and a token without the scope asks the rider to connect
  again. The workout is dragged from the library onto a day of this week's table in the Training
  area, and a planned workout onto another day; a day that has passed takes none. A change of a
  calendar behind an external API is sent at once, without a draft (ADR 0078). On the calendar
  of ridrs on this device the workout becomes an entry of the Training area on that weekday.

  Here intervals.icu, the browser and the secret store are simulated. It is Wednesday 4 November
  2026.

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-settings, ui-area-training, library-ridrs, ui-area-me, profile-local, planner-intervals-icu, ui-training-plan, ui-workout-chart" together with the simulated intervals.icu
    And a test device plugin "test-device"
    And intervals.icu knows the athlete "Alex Rider" with an FTP of 250 W and a weight of 72 kg
    And intervals.icu has the library:
      | folder | name            | type | duration | load |
      | Base   | Sweet Spot 3x12 | Ride | 1h15m    | 78   |
    And the library workout "Sweet Spot 3x12" of intervals.icu has the steps:
      | step     | duration | power  |
      | warmup   | 10m      | 50-75% |
      | repeat   | 3x       |        |
      | -        | 12m      | 90%    |
      | -        | 4m       | 55%    |
      | cooldown | 5m       | 60-40% |
    And the local time is "2026-11-04 08:00"
    And the secret store holds a token for intervals.icu
    And the host has started
    And the athlete profile of "intervals.icu" is in use
    And the main screen is 1400 px wide
    And the ridrs UI is shown

  Scenario: A library workout is planned on a day with its steps
    When I press "Training"
    And I drag the workout "Sweet Spot 3x12" onto "Thursday"
    Then intervals.icu received "POST /api/v1/athlete/0/events" with the body:
      | category         | WORKOUT             |
      | start_date_local | 2026-11-05T00:00:00 |
      | type             | Ride                |
      | name             | Sweet Spot 3x12     |
    And the event created in intervals.icu has the steps:
      | step     | duration | power  |
      | warmup   | 10m      | 50-75% |
      | repeat   | 3x       |        |
      | -        | 12m      | 90%    |
      | -        | 4m       | 55%    |
      | cooldown | 5m       | 60-40% |
    When I press Back
    Then the next workout card shows:
      | day  | Tomorrow        |
      | name | Sweet Spot 3x12 |
    And the next workout card shows a workout chart of 8 steps

  Scenario: A workout dropped on a day is shown at once, as saving, until intervals.icu answers
    Given intervals.icu holds back its answers to writes
    When I press "Training"
    And I drag the workout "Sweet Spot 3x12" onto "Thursday"
    Then the calendar day "Thursday" lists "Sweet Spot 3x12"
    And the calendar day "Thursday" lists "Saving…"
    When intervals.icu answers its writes
    Then the calendar day "Thursday" lists no "Saving…"
    And the calendar day "Thursday" lists "Sweet Spot 3x12"

  Scenario: A workout of this device is planned in intervals.icu with its content
    When I press "Training"
    And I drag the workout "Sweet Spot 3×12" onto "Thursday"
    Then intervals.icu received "POST /api/v1/athlete/0/events" with the body:
      | category         | WORKOUT             |
      | start_date_local | 2026-11-05T00:00:00 |
      | type             | VirtualRide         |
      | name             | Sweet Spot 3×12     |
      | moving_time      | 3780                |
    And the event created in intervals.icu has the description:
      """
      Three blocks of 12 minutes at 90 % FTP with 4 minutes easy between them.

      - 10m ramp 50-75% intensity=warmup

      3x
      - 12m 90% intensity=interval
      - 4m 55% intensity=recovery

      - 5m ramp 65-45% intensity=cooldown
      """
    When I press Back
    Then the next workout card shows:
      | day  | Tomorrow      |
      | name | Sweet Spot 3×12 |

  Scenario: The workout is planned with the steps exactly as the library has them
    Given the library workout "Sweet Spot 3x12" of intervals.icu has the workout document:
      """
      {
        "steps": [
          { "duration": 600, "warmup": true, "ramp": true, "power": { "units": "%ftp", "start": 50, "end": 75 } },
          { "duration": 1200, "power": { "units": "%ftp", "start": 88, "end": 94 } },
          { "duration": 900, "power": { "units": "power_zone", "value": 2 } }
        ]
      }
      """
    And I open the next workout
    And I press "Refresh"
    And I press Back
    When I press "Training"
    And I drag the workout "Sweet Spot 3x12" onto "Thursday"
    Then the event created in intervals.icu has the workout document of the library workout "Sweet Spot 3x12"

  Scenario: A planned workout is moved to another day
    Given intervals.icu plans:
      | date       | type | name         | duration | load |
      | 2026-11-05 | Ride | Threshold 20 | 1h       | 80   |
    And I open the next workout
    And I press "Refresh"
    And I press Back
    Then the next workout card shows:
      | name | Threshold 20 |
    When the rider moves the planned workout "Threshold 20" of "intervals.icu" to "2026-11-07"
    Then intervals.icu received "PUT" for the event "Threshold 20" with the body:
      | start_date_local | 2026-11-07T00:00:00 |
    And the next workout card shows:
      | day | Sat 7 Nov |

  Scenario: A planned workout is removed
    Given intervals.icu plans:
      | date       | type | name         | duration | load |
      | 2026-11-05 | Ride | Threshold 20 | 1h       | 80   |
    And I open the next workout
    And I press "Refresh"
    And I press Back
    Then the next workout card shows:
      | name | Threshold 20 |
    When the rider removes the planned workout "Threshold 20" of "intervals.icu"
    Then intervals.icu received "DELETE" for the event "Threshold 20"
    And the training tile shows "No workout planned"

  Scenario: When intervals.icu cannot be reached nothing is planned
    Given intervals.icu cannot be reached for writes
    When I press "Training"
    And I drag the workout "Sweet Spot 3x12" onto "Wednesday"
    Then the page says "intervals.icu could not be reached: nothing was planned."
    And the calendar day "Wednesday" lists no "Sweet Spot 3x12"
    When I press Back
    Then the training tile shows "No workout planned"

  Scenario: A token without the scope asks the rider to connect again
    Given intervals.icu rejects writes with 403
    When I press "Training"
    And I drag the workout "Sweet Spot 3x12" onto "Wednesday"
    Then the page says "intervals.icu cannot be changed from the library."
    And the secret store holds no intervals.icu token

  Scenario: On the calendar of ridrs the workout becomes an entry of the Training area
    When I press "Settings"
    And I press the chip "ridrs (this device)" of the row "Planned workouts"
    And I press Back
    And I press "Training"
    And I drag the workout "Sweet Spot 3x12" onto "Thursday"
    Then the calendar day "Thursday" lists "Sweet Spot 3x12"
    And intervals.icu received no write to its events
    When I press Back
    Then the next workout card shows:
      | day  | Tomorrow        |
      | name | Sweet Spot 3x12 |

  Scenario: A day that has passed takes no workout
    When I press "Training"
    And I drag the workout "Sweet Spot 3x12" onto "Tuesday"
    Then intervals.icu received no write to its events

  Scenario: A planned workout of intervals.icu is moved by dragging it to another day
    Given intervals.icu plans:
      | date       | type | name         | duration | load |
      | 2026-11-05 | Ride | Threshold 20 | 1h       | 80   |
    And I open the next workout
    And I press "Refresh"
    And I press Back
    When I press "Training"
    And I drag the planned workout "Threshold 20" onto "Saturday"
    Then intervals.icu received "PUT" for the event "Threshold 20" with the body:
      | start_date_local | 2026-11-07T00:00:00 |

  Scenario: A planned workout of next week is moved by dragging it
    Given intervals.icu plans:
      | date       | type | name         | duration | load |
      | 2026-11-10 | Ride | Threshold 20 | 1h       | 80   |
    And I open the next workout
    And I press "Refresh"
    And I press Back
    When I press "Training"
    And I press "Next week"
    Then the calendar day "Tuesday" lists "Threshold 20"
    When I drag the planned workout "Threshold 20" onto "Friday"
    Then intervals.icu received "PUT" for the event "Threshold 20" with the body:
      | start_date_local | 2026-11-13T00:00:00 |

  Scenario: The calendar is in German
    When I press "Settings"
    And I press "Deutsch"
    And I press Back
    And I press "Training"
    Then the Training area has the button "Nächste Woche"
