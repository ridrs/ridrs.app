@phase-7
Feature: The presented state at a render time
  The presentation shows the physics 60 ms in the past, interpolated between the two
  neighbouring steps. It never predicts and never blends discrete values.

  Background:
    Given the presentation receives a batch of session "s1":
      | step | at       | speed | distance | gradient |
      | 100  | +1000 ms | 5.00  | 10.00    | 0        |
      | 101  | +1010 ms | 5.10  | 10.05    | 5        |
      | 102  | +1020 ms | 5.20  | 10.10    | 5        |

  Scenario Outline: The frame at <frame> (<case>)
    Then the frame at "<frame>" presents step <step> with a speed of <speed> m/s, a distance of <distance> m and a gradient of <gradient> % "<basis>"

    Examples:
      | case                  | frame    | step | speed | distance | gradient | basis        |
      | at a step             | +1060 ms | 100  | 5.00  | 10.00    | 0        | exact        |
      | between two steps     | +1064 ms | 100  | 5.04  | 10.02    | 0        | interpolated |
      | after a gradient jump | +1076 ms | 101  | 5.16  | 10.08    | 5        | interpolated |
      | ahead of the physics  | +1090 ms | 102  | 5.20  | 10.10    | 5        | held         |

  Scenario: Before the first sample there is nothing to present
    Then the frame at "+1050 ms" presents nothing

  Scenario: A new session starts a new history
    When the presentation receives a batch of session "s2":
      | step | at       | speed | distance | gradient |
      | 0    | +5000 ms | 0.00  | 0.00     | 0        |
    Then the frame at "+1076 ms" presents nothing
    And the frame at "+5060 ms" presents step 0 with a speed of 0.00 m/s, a distance of 0.00 m and a gradient of 0 % "exact"

  Scenario: A gap is never interpolated
    When the presentation receives a batch of session "s1":
      | step | at       | speed | distance | gradient |
      | 110  | +1100 ms | 6.00  | 10.60    | 5        |
    Then the frame at "+1110 ms" presents step 102 with a speed of 5.20 m/s, a distance of 10.10 m and a gradient of 5 % "held"

  Scenario: The history keeps two seconds
    When the presentation receives a batch of session "s1":
      | step | at       | speed | distance | gradient |
      | 103  | +1030 ms | 5.30  | 10.15    | 5        |
    And the presentation receives a batch of session "s1":
      | step | at       | speed | distance | gradient |
      | 400  | +4000 ms | 9.00  | 30.00    | 0        |
    Then the frame at "+1063 ms" presents nothing
    And the frame at "+4060 ms" presents step 400 with a speed of 9.00 m/s, a distance of 30.00 m and a gradient of 0 % "exact"
    And the presented states are read-only
