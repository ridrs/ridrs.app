@workout
Feature: Targets are resolved with the athlete's profile, never stored converted
  A workout keeps the units of its source (ADR 0081). Showing resolves them live, a ride once at
  its start: % FTP and power zones become watts with the FTP and the zones of the profile, % LTHR,
  % of the maximum heart rate and heart rate zones become bpm (ADR 0082). Watts and bpm stay as
  they are. What cannot be resolved says why; nothing is guessed. Resolved values are whole watts
  and bpm.

  Scenario: The default power zones are Coggan's seven
    Then the default power zones end at 55, 75, 90, 105, 120 and 150 % FTP, the last one open
    And the default power zones are named "Active Recovery, Endurance, Tempo, Threshold, VO2 Max, Anaerobic Capacity, Neuromuscular Power"

  Scenario: The default heart rate zones follow Friel's bounds from the LTHR
    # 81, 89, 93, 99, 102 and 106 % of 170 bpm: 137.7, 151.3, 158.1, 168.3, 173.4, 180.2
    Then the default heart rate zones for an LTHR of 170 bpm end at 138, 151, 158, 168, 173 and 180 bpm, the last one open

  Scenario Outline: A value lies in the zone whose upper bound it does not pass
    Then <value> % FTP lies in default power zone <zone>

    Examples:
      | value | zone |
      | 0     | 1    |
      | 55    | 1    |
      | 55.5  | 2    |
      | 90    | 3    |
      | 90.5  | 4    |
      | 150   | 6    |
      | 151   | 7    |

  Scenario Outline: Power targets become watts with the FTP and the zones of the profile
    Given an athlete for workouts with an FTP of 250 W and the default power zones
    Then the target "<target>" resolves to "<resolved>"

    Examples:
      | target        | resolved        |
      | 90 %          | 225 W           |
      | 88–94 %       | 220–235 W       |
      | ramp 50→75 %  | ramp 125→188 W  |
      | Z2            | 138–188 W       |
      | Z7            | 375 W and above |
      | 200–220 W     | 200–220 W       |
      | 90 rpm        | 90 rpm          |

  Scenario: Without an FTP a % target cannot be resolved, a watt target still can
    Given an athlete for workouts without an FTP
    Then the target "90 %" cannot be resolved: "no-ftp"
    And the target "Z2" cannot be resolved: "no-ftp"
    And the target "200–220 W" resolves to "200–220 W"

  Scenario: Without zones in the profile a zone target cannot be resolved
    Given an athlete for workouts with an FTP of 250 W
    Then the target "Z2" cannot be resolved: "no-power-zones"
    And the target "Z9" cannot be resolved: "no-power-zones"

  Scenario: A zone the profile does not have cannot be resolved
    Given an athlete for workouts with an FTP of 250 W and the default power zones
    Then the target "Z9" cannot be resolved: "unknown-zone"

  Scenario Outline: Heart rate targets become bpm
    Given an athlete for workouts with an LTHR of 170 bpm, a maximum heart rate of 190 bpm and the default heart rate zones
    Then the target "<target>" resolves to "<resolved>"

    Examples:
      | target      | resolved    |
      | 95 % LTHR   | 162 bpm     |
      | 80 % max HR | 152 bpm     |
      | HR Z2       | 138–151 bpm |
      | 140 bpm     | 140 bpm     |

  Scenario: Without an LTHR a % LTHR target cannot be resolved
    Given an athlete for workouts without an FTP
    Then the target "95 % LTHR" cannot be resolved: "no-lthr"
    And the target "80 % max HR" cannot be resolved: "no-max-heart-rate"
    And the target "HR Z2" cannot be resolved: "no-heart-rate-zones"

  Scenario: A workout is resolved whole for the ride, and the workout itself stays as it is
    Given a workout "Sweet Spot 3×12" built from these steps:
      | id  | duration | target       |
      | 1   | 10 min   | ramp 50→75 % |
      | 2   | 3×       |              |
      | 2.1 | 12 min   | 90 %         |
      | 2.2 | 4 min    | 55 %         |
      | 3   | 2 min    | ramp 60→40 % |
    And an athlete for workouts with an FTP of 250 W and the default power zones
    When the workout is resolved for the ride
    Then the resolved workout targets:
      | step | target         |
      | 1    | ramp 125→188 W |
      | 2.1  | 225 W          |
      | 2.2  | 138 W          |
      | 3    | ramp 150→100 W |
    And nothing in the resolved workout is left unresolved
    And the workout itself still targets "90 %" in step "2.1"

  Scenario: What cannot be resolved for the ride is named and left as it is
    Given a workout "Mixed units" built from these steps:
      | id | duration | target    |
      | 1  | 10 min   | 90 %      |
      | 2  | 10 min   | 200 W     |
      | 3  | 10 min   | Z7        |
    And an athlete for workouts without an FTP
    When the workout is resolved for the ride
    Then the resolved workout targets:
      | step | target |
      | 1    | 90 %   |
      | 2    | 200 W  |
      | 3    | Z7     |
    And the resolved workout leaves these unresolved:
      | step | problem |
      | 1    | no-ftp  |
      | 3    | no-ftp  |
