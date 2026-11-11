@workout
Feature: A workout's numbers are derived, never stored
  Duration, normalised power (NP), intensity factor (IF), training load (TSS), work in kJ and the
  time per zone come from the targets: ranges count at their middle, ramps rise linearly. The
  power is sampled every second at the middle of that second, which integrates a ramp exactly.
  NP is the fourth root of the mean fourth power of the 30-second rolling average, IF is NP over
  the FTP, and the load is hours × IF² × 100, which equals s × NP × IF / (FTP × 3600) × 100.
  Steps without a power target count at an assumed intensity (a free ride 60 %, max effort 150 %,
  heart rate 65 %, anything else 60 % FTP), and the numbers say they are estimated. Zones and
  watts need an FTP; a workout in watts needs one for its IF and load.

  Background:
    Given a workout "Sweet Spot 3×12" built from these steps:
      | id  | duration | target       |
      | 1   | 10 min   | ramp 50→75 % |
      | 2   | 3×       |              |
      | 2.1 | 12 min   | 90 %         |
      | 2.2 | 4 min    | 55 %         |
      | 3   | 2 min    | ramp 60→40 % |

  Scenario: An hour at FTP is a load of 100
    Given a workout "An hour at FTP" built from these steps:
      | id | duration | target |
      | 1  | 1 h      | 100 %  |
    And an athlete for workouts with an FTP of 250 W and the default power zones
    When the workout's numbers are derived
    # 250 W for 3600 s: NP 250 W, IF 1.00, load 1 h × 1.00² × 100 = 100, 250 × 3600 / 1000 = 900 kJ
    Then the workout's numbers are:
      | duration          | 1:00:00 |
      | estimated         | no      |
      | normalised power  | 250 W   |
      | intensity factor  | 1.00    |
      | training load     | 100     |
      | work              | 900 kJ  |

  Scenario: A sweet spot workout, with the athlete's FTP
    Given an athlete for workouts with an FTP of 250 W and the default power zones
    When the workout's numbers are derived
    # By hand, without the rolling average: the mean of p⁴ (p in FTP) is
    #   ramp 50→75 % over 600 s: (0.75⁵ − 0.50⁵) / (5 × 0.25) × 600 = 98.9
    #   0.90⁴ × 2160 s = 1417.2;  0.55⁴ × 720 s = 65.9
    #   ramp 60→40 % over 120 s: (0.60⁵ − 0.40⁵) / (5 × 0.20) × 120 = 8.1
    #   (1590.1 / 3600)^¼ = 0.815: NP 204 W, IF 0.82, load 0.815² × 100 = 66.4.
    # The rolling average changes this only a little (0.8154): it smooths the six changes between
    # 90 % and 55 %, and its first value comes after 30 s, past the lowest part of the warm-up.
    # Work: mean power (62.5 × 600 + 90 × 2160 + 55 × 720 + 50 × 120) / 3600 = 77.08 % = 192.7 W,
    # × 3600 s = 694 kJ.
    Then the workout's numbers are:
      | duration          | 1:00:00 |
      | estimated         | no      |
      | normalised power  | 204 W   |
      | intensity factor  | 0.82    |
      | training load     | 66      |
      | work              | 694 kJ  |
    # Zone 1 (up to 55 %): 2:00 of the warm-up, 3 × 4:00, 1:30 of the cool-down = 15:30.
    # Zone 2 (up to 75 %): 8:00 of the warm-up and 0:30 of the cool-down = 8:30. Zone 3: 3 × 12:00.
    And the workout spends this time per zone:
      | zone | time  |
      | 1    | 15:30 |
      | 2    | 8:30  |
      | 3    | 36:00 |
      | 4    | 0:00  |
      | 5    | 0:00  |
      | 6    | 0:00  |
      | 7    | 0:00  |

  Scenario: Without an FTP a % workout has a load, but no watts and no zones
    Given an athlete for workouts without an FTP
    When the workout's numbers are derived
    Then the workout's numbers are:
      | intensity factor | 0.82 |
      | training load    | 66   |
    And the workout's numbers have no normalised power in watts, no work and no time per zone

  Scenario: A workout in watts without an FTP has watts and work, but no load
    Given a workout "In watts" built from these steps:
      | id | duration | target |
      | 1  | 30 min   | 200 W  |
    And an athlete for workouts without an FTP
    When the workout's numbers are derived
    # 200 W × 1800 s = 360 kJ
    Then the workout's numbers are:
      | normalised power | 200 W  |
      | work             | 360 kJ |
    And the workout's numbers have no intensity factor and no load

  Scenario: A free ride counts at an assumed intensity, and the numbers say so
    Given a workout "Half free" built from these steps:
      | id | duration | target    |
      | 1  | 30 min   | 100 %     |
      | 2  | 30 min   | free ride |
    And an athlete for workouts with an FTP of 250 W and the default power zones
    When the workout's numbers are derived
    # 1800 s at 100 % and 1800 s at 60 % (assumed): work (250 + 150) × 1800 / 1000 = 720 kJ
    Then the workout's numbers are:
      | duration  | 1:00:00 |
      | estimated | yes     |
      | work      | 720 kJ  |
    And the workout spends 30:00 without a power target

  Scenario: ERG rides the steps whose power target can be resolved
    Given a workout "Mixed" built from these steps:
      | id | duration | target    |
      | 1  | 10 min   | 90 %      |
      | 2  | 10 min   | 200 W     |
      | 3  | 10 min   | free ride |
      | 4  | 10 min   | 140 bpm   |
      | 5  | 10 s     | max effort |
    And an athlete for workouts without an FTP
    When the workout's numbers are derived
    Then ERG can ride the steps "2"
    Given an athlete for workouts with an FTP of 250 W
    When the workout's numbers are derived
    Then ERG can ride the steps "1, 2"
