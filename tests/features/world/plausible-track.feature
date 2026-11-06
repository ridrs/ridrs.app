@phase-10
Feature: The GPX track is made plausible before the video time is built
  A route is filmed from a bicycle or a motorbike: neither brakes or speeds up harder than
  4 m/s², nor takes a curve harder than 5 m/s². A GPX fix that would need more is a GPS error.
  Before the track is built, fixes out of time order and fixes thrown sideways or backwards are
  dropped, a jump of the GPS is taken out of the distance, and a run of fixes that lags and
  catches up again is bridged (ADR 0063). Real riding is left as it is.

  Scenario: A fix out of time order is dropped
    Given a straight track filmed at 20 km/h for 120 s with a point every second
    And the point at 60 s repeated
    When the track is made plausible
    Then 1 point is dropped as "time"

  Scenario: A fix thrown sideways is dropped
    Given a straight track filmed at 20 km/h for 120 s with a point every second
    And the point at 60 s thrown 15 m sideways
    When the track is made plausible
    Then the point at 60 s is dropped as "spike"
    And the track is as long as the camera rode, within 0.5 m

  Scenario: A fix thrown backwards is dropped
    Given a straight track filmed at 20 km/h for 120 s with a point every second
    And the point at 60 s thrown 20 m back along the road
    When the track is made plausible
    Then the point at 60 s is dropped as "spike"
    And the track is as long as the camera rode, within 0.5 m

  Scenario: A jump of the GPS is taken out of the distance
    Given a straight track filmed at 20 km/h for 120 s with a point every second
    And every point from 60 s on shifted 25 m ahead along the road
    When the track is made plausible
    Then a jump of 25 m at 60 s is taken out, within 1 m
    And the track is as long as the camera rode, within 1 m
    And a rider at a steady 20 km/h sees the video at the camera's speed, within 5 %

  Scenario: A GPS that lags and catches up is bridged
    Given a straight track filmed at 45 km/h for 120 s with a point every second
    And the points from 60 s to 63 s lagging 10, 20, 25 and 15 m behind
    When the track is made plausible
    Then the points from 60 s to 63 s are dropped as "lag"
    And the track is as long as the camera rode, within 0.5 m
    And a rider at a steady 45 km/h sees the video at the camera's speed, within 5 %

  Scenario Outline: Real riding is left as it is: <ride>
    Given a track of <ride>
    When the track is made plausible
    Then nothing is repaired

    Examples:
      | ride                                                              |
      | a hairpin of 10 m radius at 18 km/h with a point every second     |
      | braking from 40 km/h to a stop at 3 m/s² with a point every second |
      | a curve of 100 m radius at 80 km/h with a point every second      |
      | a hairpin of 10 m radius at 18 km/h with a point every 10 s       |
      | a steady 20 km/h with every point off by up to 1 m with the seed 3 |
