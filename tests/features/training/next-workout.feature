@training @ui
Feature: The next planned workout on the main screen
  Once intervals.icu is connected, the main screen shows the next planned cycling workout of the
  next 14 days as a small card: the day, the name, the duration, the training load and, when
  intervals.icu has its steps, a power profile. Enter on the card opens the details: the
  description, the athlete's FTP and weight, and the steps in % FTP and in watts. Back returns to
  the main screen (AGENTS.md rule 12). The plan loads at start, after a saved ride and on Refresh.
  Offline, the last plan is shown and marked as such.

  Here intervals.icu, the browser and the secret store are simulated.

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, planner-intervals-icu, ui-training-plan" together with the simulated intervals.icu
    And intervals.icu knows the athlete "Alex Rider" with an FTP of 250 W and a weight of 72 kg
    And the secret store holds a token for intervals.icu
    And the local time is "2026-11-04 08:00"

  Scenario: The plan of the next 14 days loads at start
    When the host has started
    Then intervals.icu received "GET /api/v1/athlete/0" with the token
    And intervals.icu received "GET /api/v1/athlete/0/events?oldest=2026-11-04&newest=2026-11-17&category=WORKOUT" with the token

  Scenario: The card shows the next cycling workout
    Given intervals.icu plans:
      | date       | type        | name            | duration | load |
      | 2026-11-03 | Ride        | Yesterday's Z2  | 1h       | 50   |
      | 2026-11-05 | Run         | Easy Run        | 40m      | 30   |
      | 2026-11-06 | VirtualRide | Sweet Spot 3x12 | 1h15m    | 78   |
      | 2026-11-08 | Ride        | Long Endurance  | 3h       | 140  |
    When the host has started
    And the ridrs UI is shown
    Then the next workout card shows:
      | day      | Fri 6 Nov       |
      | name     | Sweet Spot 3x12 |
      | duration | 1 h 15 min      |
      | load     | Load 78         |

  Scenario Outline: The card names the day relative to today
    Given intervals.icu plans:
      | date   | type | name     | duration | load |
      | <date> | Ride | Tempo 40 | 1h       | 60   |
    When the host has started
    And the ridrs UI is shown
    Then the next workout card shows:
      | day | <day> |

    Examples:
      | date       | day        |
      | 2026-11-04 | Today      |
      | 2026-11-05 | Tomorrow   |
      | 2026-11-10 | Tue 10 Nov |

  Scenario: Without a planned ride the card says so
    Given intervals.icu plans:
      | date       | type | name     | duration | load |
      | 2026-11-05 | Run  | Easy Run | 40m      | 30   |
    When the host has started
    And the ridrs UI is shown
    Then the main panel shows "No workout planned"

  Scenario: A workout with steps shows its power profile
    Given intervals.icu plans "Sweet Spot 3x12" on "2026-11-04" with the steps:
      | step     | duration | power  |
      | warmup   | 10m      | 50-75% |
      | repeat   | 3x       |        |
      | -        | 12m      | 90%    |
      | -        | 4m       | 55%    |
      | cooldown | 5m       | 60-40% |
    When the host has started
    And the ridrs UI is shown
    Then the next workout card shows a power profile of 8 bars

  Scenario: A workout without steps shows no power profile
    Given intervals.icu plans:
      | date       | type | name     | duration | load |
      | 2026-11-04 | Ride | Tempo 40 | 1h       | 60   |
    When the host has started
    And the ridrs UI is shown
    Then the next workout card shows no power profile

  Scenario: Enter on the card opens the details, Back returns
    Given intervals.icu plans "Sweet Spot 3x12" on "2026-11-04" with the description "Stay seated in the intervals." and the steps:
      | step     | duration | power  |
      | warmup   | 10m      | 50-75% |
      | repeat   | 3x       |        |
      | -        | 12m      | 90%    |
      | -        | 4m       | 55%    |
      | cooldown | 5m       | 60-40% |
    And the host has started
    And the ridrs UI is shown
    When I press the arrow key "Down"
    And I press the arrow key "Down"
    Then the focus is on the next workout card
    When I press Enter
    Then the "training-workout" screen is shown
    And the workout details show "Stay seated in the intervals."
    And the workout details show the athlete's FTP "250 W" and weight "72 kg"
    And the workout details list the steps:
      | step       | duration | target                  |
      | Warm-up    | 10 min   | 50–75 % FTP · 125–188 W |
      | 3×         |          |                         |
      |            | 12 min   | 90 % FTP · 225 W        |
      |            | 4 min    | 55 % FTP · 138 W        |
      | Cool-down  | 5 min    | 60–40 % FTP · 150–100 W |
    When I press Back
    Then the "main" screen is shown

  Scenario: Refresh loads the plan again
    Given intervals.icu plans:
      | date       | type | name     | duration | load |
      | 2026-11-04 | Ride | Tempo 40 | 1h       | 60   |
    And the host has started
    And the ridrs UI is shown
    And intervals.icu plans:
      | date       | type | name         | duration | load |
      | 2026-11-04 | Ride | Threshold 20 | 1h       | 80   |
    When I open the next workout
    And I press "Refresh"
    And I press Back
    Then the next workout card shows:
      | name | Threshold 20 |

  Scenario: A saved ride loads the plan again
    Given intervals.icu plans:
      | date       | type | name     | duration | load |
      | 2026-11-04 | Ride | Tempo 40 | 1h       | 60   |
    And the host has started
    And intervals.icu plans:
      | date       | type | name           | duration | load |
      | 2026-11-06 | Ride | Long Endurance | 3h       | 140  |
    When a ride is saved
    And the ridrs UI is shown
    Then the next workout card shows:
      | name | Long Endurance |

  Scenario: Offline, the last plan is shown and marked
    Given intervals.icu plans:
      | date       | type | name     | duration | load |
      | 2026-11-04 | Ride | Tempo 40 | 1h       | 60   |
    And the host has started
    And the host is restarted while intervals.icu is unreachable
    When the ridrs UI is shown
    Then the next workout card shows:
      | name | Tempo 40 |
    And the main panel shows "Offline"
