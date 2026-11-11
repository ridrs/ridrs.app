@training
Feature: The zones of the athlete profile come from intervals.icu and go back to it
  With intervals.icu as the source of the athlete profile, the power and heart rate zones are read
  from the Ride sport settings (`power_zones`, `power_zone_names`, `hr_zones`, `hr_zone_names`)
  and written back with `PUT sport-settings/Ride`, like the FTP (ADR 0082). Power zones are upper
  bounds in % FTP, heart rate zones in bpm; the last zone is open (intervals.icu writes 999 for
  power and the maximum heart rate for heart rate). A change equal to the held zones is not sent
  (ADR 0078).

  Here intervals.icu, the browser and the secret store are simulated.

  Background:
    Given the ridrs plugins "planner-intervals-icu" together with the simulated intervals.icu
    And intervals.icu knows the athlete "Alex Rider" with an FTP of 250 W and a weight of 72 kg
    And intervals.icu keeps the Ride zones:
      | field            | values                                            |
      | power_zones      | 55, 75, 90, 105, 120, 150, 999                    |
      | power_zone_names | Recovery, Endurance, Tempo, Threshold, VO2, Anaerobic, Sprint |
      | hr_zones         | 138, 154, 162, 171, 176, 181, 190                 |
      | hr_zone_names    | Z1, Z2, Z3, Z4, Z5a, Z5b, Z5c                     |
    And the local time is "2026-11-04 08:00"
    And the secret store holds a token for intervals.icu
    And the host has started

  Scenario: The zones are read from the Ride settings
    Then the athlete profile of "intervals.icu" has the power zones:
      | name      | up to |
      | Recovery  | 55    |
      | Endurance | 75    |
      | Tempo     | 90    |
      | Threshold | 105   |
      | VO2       | 120   |
      | Anaerobic | 150   |
      | Sprint    |       |
    And the athlete profile of "intervals.icu" has the heart rate zones:
      | name | up to |
      | Z1   | 138   |
      | Z2   | 154   |
      | Z3   | 162   |
      | Z4   | 171   |
      | Z5a  | 176   |
      | Z5b  | 181   |
      | Z5c  |       |

  Scenario: Changed zones are written back to the Ride settings
    When the rider changes the zones of the profile of "intervals.icu" to:
      | kind  | name     | up to |
      | power | Easy     | 60    |
      | power | Steady   | 85    |
      | power | Hard     | 105   |
      | power | All out  |       |
      | hr    | Low      | 140   |
      | hr    | High     |       |
    Then intervals.icu received 1 requests "PUT /api/v1/athlete/0/sport-settings/Ride"
    And intervals.icu received "PUT /api/v1/athlete/0/sport-settings/Ride" with the body:
      | power_zones      | 60,85,105,999            |
      | power_zone_names | Easy,Steady,Hard,All out |
      | hr_zones         | 140,190                  |
      | hr_zone_names    | Low,High                 |
    And the athlete profile of "intervals.icu" has the power zones:
      | name    | up to |
      | Easy    | 60    |
      | Steady  | 85    |
      | Hard    | 105   |
      | All out |       |

  Scenario: Zones equal to the held ones are not sent
    When the rider changes the zones of the profile of "intervals.icu" to:
      | kind  | name      | up to |
      | power | Recovery  | 55    |
      | power | Endurance | 75    |
      | power | Tempo     | 90    |
      | power | Threshold | 105   |
      | power | VO2       | 120   |
      | power | Anaerobic | 150   |
      | power | Sprint    |       |
    Then intervals.icu received 0 requests "PUT /api/v1/athlete/0/sport-settings/Ride"
