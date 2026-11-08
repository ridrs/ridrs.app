@ui @training
Feature: The rider chooses where the planned workouts come from
  The planned workouts (the calendar) are a data type with one chosen source (ADR 0075): ridrs on
  this device, whose workouts are the Training area's calendar entries of this week from today on,
  or intervals.icu, whose workouts are its planned rides of the next 14 days. The settings page
  has a row "Planned workouts" beside the athlete profile's, and the next workout card on the main
  screen follows the chosen source. The first start chooses intervals.icu when its account is
  connected.

  Here intervals.icu, the browser and the secret store are simulated. It is Wednesday 4 November
  2026; the Training area starts with workouts on Tuesday, Thursday and Saturday.

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-settings, ui-area-training, profile-local, planner-intervals-icu, ui-training-plan" together with the simulated intervals.icu
    And a test device plugin "test-device"
    And intervals.icu knows the athlete "Alex Rider" with an FTP of 250 W and a weight of 72 kg
    And the local time is "2026-11-04 08:00"
    And intervals.icu plans:
      | date       | type | name         | duration | load |
      | 2026-11-06 | Ride | Threshold 20 | 1h       | 80   |

  Scenario: Settings lists every provider of the planned workouts
    Given the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Settings"
    Then the row "Planned workouts" offers "ridrs (this device), intervals.icu"
    And the row "Planned workouts" has "ridrs (this device)" chosen
    And the row "Planned workouts" shows the status "Ready"

  Scenario: Without an account the next workout is the Training area's
    Given the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    Then the next workout card shows:
      | day  | Tomorrow    |
      | name | VO2 Max 5×4  |
    And the training tile shows "ridrs (this device)"

  Scenario: The first start chooses intervals.icu when its account is connected
    Given the secret store holds a token for intervals.icu
    And the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    Then the next workout card shows:
      | name | Threshold 20 |
    When I press "Settings"
    Then the row "Planned workouts" has "intervals.icu" chosen
    And the row "Planned workouts" shows a status starting with "Ready"

  Scenario: The next workout card follows the choice
    Given the secret store holds a token for intervals.icu
    And the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Settings"
    And I press the chip "ridrs (this device)" of the row "Planned workouts"
    And I press Back
    Then the next workout card shows:
      | name | VO2 Max 5×4 |
    When I press "Settings"
    And I press the chip "intervals.icu" of the row "Planned workouts"
    And I press Back
    Then the next workout card shows:
      | name | Threshold 20 |

  Scenario: The choice of the calendar is kept when ridrs restarts, apart from the profile's
    Given the secret store holds a token for intervals.icu
    And the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Settings"
    And I press the chip "ridrs (this device)" of the row "Planned workouts"
    And ridrs restarted
    And I reload the UI
    And I press "Settings"
    Then the row "Planned workouts" has "ridrs (this device)" chosen
    And the row "Athlete profile" has "intervals.icu" chosen

  Scenario: A change in the Training area reaches the next workout card
    Given the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Training"
    And I press "Remove VO2 Max 5×4 from Thursday"
    And I press Back
    Then the next workout card shows:
      | day  | Sat 7 Nov   |
      | name | Endurance 90 |

  Scenario: Offline, the calendar of intervals.icu is marked
    Given the secret store holds a token for intervals.icu
    And the host has started
    And the host is restarted while intervals.icu is unreachable
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Settings"
    Then the row "Planned workouts" has "intervals.icu" chosen
    And the row "Planned workouts" shows a status starting with "Offline · last loaded"

  Scenario: The settings are in German
    Given the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Settings"
    And I press "Deutsch"
    Then the row "Geplante Trainings" offers "ridrs (dieses Gerät), intervals.icu"
    And the row "Geplante Trainings" shows the status "Bereit"
