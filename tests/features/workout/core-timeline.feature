@workout
Feature: A workout unrolls into a timeline the player and the HUD follow
  Repeats with a count are unrolled; every segment knows its step and its round ("2/3"). Steps
  that do not end by time get an estimated length, from documented assumptions: distance at
  30 km/h, energy at 150 W (1 kcal burnt is about 1 kJ of work), the lap button and "until" steps
  5 minutes. A repeat that ends by time, distance, energy or a condition is unrolled once. Every
  estimate is marked.

  Background:
    Given a workout "Sweet Spot 3×12" built from these steps:
      | id  | duration | target       |
      | 1   | 10 min   | ramp 50→75 % |
      | 2   | 3×       |              |
      | 2.1 | 12 min   | 90 %         |
      | 2.2 | 4 min    | 55 %         |
      | 3   | 2 min    | ramp 60→40 % |

  Scenario: Repeats are unrolled, and every segment knows its round
    When the workout's timeline is made
    Then the timeline lasts 1:00:00, not estimated
    And the timeline has these segments:
      | step | round | starts | lasts | estimated |
      | 1    |       | 0:00   | 10:00 | no        |
      | 2.1  | 1/3   | 10:00  | 12:00 | no        |
      | 2.2  | 1/3   | 22:00  | 4:00  | no        |
      | 2.1  | 2/3   | 26:00  | 12:00 | no        |
      | 2.2  | 2/3   | 38:00  | 4:00  | no        |
      | 2.1  | 3/3   | 42:00  | 12:00 | no        |
      | 2.2  | 3/3   | 54:00  | 4:00  | no        |
      | 3    |       | 58:00  | 2:00  | no        |

  Scenario: The player finds the segment of a moment
    When the workout's timeline is made
    Then at 0:00 the timeline is in step "1" with 10:00 left
    And at 30:00 the timeline is in step "2.1", round "2/3", with 8:00 left
    And at 58:00 the timeline is in step "3" with 2:00 left
    And at 1:00:00 the timeline has ended

  Scenario: Distance, energy, lap button and until steps get an estimated, marked length
    Given a workout "Mixed" built from these steps:
      | id | duration                       | target    |
      | 1  | 10 min                         | 60 %      |
      | 2  | 5 km                           | 75 %      |
      | 3  | 90 kcal                        | 60 %      |
      | 4  | open                           | free ride |
      | 5  | until heart rate below 110 bpm | 50 %      |
    When the workout's timeline is made
    Then the timeline lasts 40:00, estimated
    And the timeline has these segments:
      | step | round | starts | lasts | estimated |
      | 1    |       | 0:00   | 10:00 | no        |
      | 2    |       | 10:00  | 10:00 | yes       |
      | 3    |       | 20:00  | 10:00 | yes       |
      | 4    |       | 30:00  | 5:00  | yes       |
      | 5    |       | 35:00  | 5:00  | yes       |

  Scenario: A repeat that ends by time is unrolled once and marked
    Given a workout "Until twenty minutes" built from these steps:
      | id  | duration   | target |
      | 1   | for 20 min |        |
      | 1.1 | 2 min      | 100 %  |
      | 1.2 | 1 min      | 50 %   |
    When the workout's timeline is made
    Then the timeline lasts 3:00, estimated
    And the timeline has these segments:
      | step | round | starts | lasts | estimated |
      | 1.1  | 1/?   | 0:00   | 2:00  | no        |
      | 1.2  | 1/?   | 2:00   | 1:00  | no        |
