@workout
Feature: A workout is checked against the editor's limits
  Beyond its schema, a workout has a name and steps, its steps have unique ids, a range's low end
  is not above its high end, durations are above zero, power lies between 0 and 300 % FTP and a
  repeat runs 1 to 99 times (structured-workouts.md, section 12). Every problem has a stable code
  and names its step; the UI words it.

  Scenario: A sound workout has no problems
    Given a workout "Sweet Spot 3×12" built from these steps:
      | id  | duration | target       |
      | 1   | 10 min   | ramp 50→75 % |
      | 2   | 3×       |              |
      | 2.1 | 12 min   | 90 %         |
      | 2.2 | 4 min    | 55 %         |
    When the workout is checked
    Then the check finds no problems

  Scenario: Every broken limit is named by its code and its step
    Given a workout "" built from these steps:
      | id  | duration | target  |
      | 1   | 0 min    | 90 %    |
      | 2   | 100×     |         |
      | 2.1 | 1 min    | 320 %   |
      | 2.2 | 1 min    | 80–70 % |
      | 1   | 1 min    | 50 %    |
    When the workout is checked
    Then the check finds these problems:
      | code                      | step |
      | name-missing              |      |
      | duration-not-positive     | 1    |
      | repeat-count-out-of-range | 2    |
      | power-out-of-range        | 2.1  |
      | range-inverted            | 2.2  |
      | step-id-duplicate         | 1    |

  Scenario: Up to 300 % FTP and 99 repeats are fine
    Given a workout "Sprints" built from these steps:
      | id  | duration | target |
      | 1   | 99×      |        |
      | 1.1 | 10 s     | 300 %  |
    When the workout is checked
    Then the check finds no problems

  Scenario: A workout needs steps, and a repeat needs steps to repeat
    Given a workout "Nothing" built from these steps:
      | id | duration | target |
      | 1  | 2×       |        |
    When the workout is checked
    Then the check finds these problems:
      | code         | step |
      | repeat-empty | 1    |
    Given a workout "Even less" without steps
    When the workout is checked
    Then the check finds these problems:
      | code     | step |
      | no-steps |      |
