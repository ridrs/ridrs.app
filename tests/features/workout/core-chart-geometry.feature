@workout
Feature: The chart geometry of a workout is plain data
  `layoutWorkout` turns a workout into polygons, axes and brackets for the chart, the editor and
  the HUD (structured-workouts.md, section 5.1). Width is time; height is intensity on a fixed
  scale of 0–150 % FTP, so that workouts compare; higher values are clipped and marked. A workout
  in watts gets a watt axis while there is no FTP. With an FTP every shape knows its zone; without
  one the shapes are neutral. Steps without a power target are hatched at an assumed height. No
  words: the chart plugin words what it draws. In a 600 × 150 chart of an hour, 1 px is 6 s and,
  on the % axis, 1 % FTP.

  Background:
    Given a workout "Sweet Spot 3×12" built from these steps:
      | id  | duration | target       |
      | 1   | 10 min   | ramp 50→75 % |
      | 2   | 3×       |              |
      | 2.1 | 12 min   | 90 %         |
      | 2.2 | 4 min    | 55 %         |
      | 3   | 2 min    | ramp 60→40 % |

  Scenario: A ramp is drawn as a trapezoid, a steady step as a rectangle, each in its zone
    Given an athlete for workouts with an FTP of 250 W and the default power zones
    When the workout is laid out at 600 × 150
    Then the chart draws segment 1 as the polygon "(0,150) (0,100) (100,75) (100,150)" in zone 2
    And the chart draws segment 2 as the polygon "(100,150) (100,60) (220,60) (220,150)" in zone 3
    And the chart draws segment 3 as the polygon "(220,150) (220,95) (260,95) (260,150)" in zone 1

  Scenario: A range is drawn as a band from its low to its high value
    Given a workout "Range" built from these steps:
      | id | duration | target  |
      | 1  | 20 min   | 88–94 % |
    When the workout is laid out at 600 × 150
    Then the chart draws segment 1 as the polygon "(0,150) (0,59) (600,59) (600,150)" in no zone
    And the chart draws segment 1 with the band "(0,56) (600,56) (600,62) (0,62)"

  Scenario: Without an FTP the shapes are neutral
    When the workout is laid out at 600 × 150
    Then the chart draws segment 2 as the polygon "(100,150) (100,60) (220,60) (220,150)" in no zone
    And the chart's axis is in "percent-ftp" up to 150 with ticks "0, 50, 100, 150" and no watts

  Scenario: Values above 150 % FTP are clipped and marked
    Given a workout "Too hard" built from these steps:
      | id | duration | target |
      | 1  | 1 min    | 200 %  |
      | 2  | 1 min    | 150 %  |
    When the workout is laid out at 120 × 150
    Then the chart draws segment 1 as the polygon "(0,150) (0,0) (60,0) (60,150)" in no zone
    And the chart clips segment 1
    And the chart does not clip segment 2

  Scenario: A workout in watts without an FTP gets a watt axis
    Given a workout "In watts" built from these steps:
      | id | duration | target |
      | 1  | 10 min   | 200 W  |
      | 2  | 5 min    | 300 W  |
    When the workout is laid out at 600 × 150
    # The axis reaches 10 % above the highest target, rounded up to 50 W: 330 → 350 W.
    Then the chart's axis is in "watts" up to 350 with ticks "0, 100, 200, 300"
    And the chart has no FTP line
    # 150 − 200 / 350 × 150 = 64.29
    And the chart draws segment 1 at a height of y 64.29
    Given an athlete for workouts with an FTP of 250 W
    When the workout is laid out at 600 × 150
    Then the chart's axis is in "percent-ftp" up to 150 with ticks "0, 50, 100, 150" and watts "0, 125, 250, 375"
    # 200 W of 250 W: 80 %
    And the chart draws segment 1 at a height of y 70

  Scenario: Free ride, heart rate, lap button and max effort steps are hatched at an estimated height
    Given a workout "Unusual" built from these steps:
      | id | duration | target     |
      | 1  | 5 min    | free ride  |
      | 2  | 5 min    | 140 bpm    |
      | 3  | open     | 80 %       |
      | 4  | 10 s     | max effort |
    When the workout is laid out at 600 × 150
    Then the chart hatches these segments:
      | segment | marker     | height | height estimated | width estimated |
      | 1       | free       | 60 %   | yes              | no              |
      | 2       | heart-rate | 65 %   | yes              | no              |
      | 3       | open       | 80 %   | no               | yes             |
      | 4       | max-effort | 150 %  | yes              | no              |

  Scenario: The axes, the FTP line and the repeat brackets of the full chart
    Given an athlete for workouts with an FTP of 250 W and the default power zones
    When the workout is laid out at 600 × 150
    Then the chart's time axis is ticked at "0:00, 10:00, 20:00, 30:00, 40:00, 50:00, 1:00:00"
    And the chart's FTP line lies at y 50
    And the chart brackets "3×" from x 100 to x 580

  Scenario: The micro chart is only a silhouette
    When the workout is laid out at 120 × 18 as "micro"
    Then the chart has no FTP line, no axes and no brackets

  Scenario: The chart describes its structure for the accessible description
    Given an athlete for workouts with an FTP of 250 W and the default power zones
    When the workout is laid out at 600 × 150
    Then the chart's summary is a 1:00:00 workout, not estimated, with 3 intervals of 12:00 at 90 %

  Scenario: The geometry is remembered per workout and size
    When the workout is laid out at 600 × 150
    And the workout is laid out again at 600 × 150
    Then the chart layout is the very same as before
    When the workout is laid out again at 300 × 56
    Then the chart layout is a new one
