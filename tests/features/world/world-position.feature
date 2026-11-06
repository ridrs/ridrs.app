@phase-10 @fake-timers
Feature: Where the rider is enters through the world driver
  A landscape that knows the real place of its route (a video ride) publishes where it shows
  the rider as the raw event "ui.position-observed". The driver "world-driver-ui" validates
  every position and accepts a valid one as the external input "world.position", which the
  recording keeps and the FIT export writes into its records; an invalid one is dropped and
  reported.

  Background:
    Given the ridrs plugins "activity-session, world-driver-ui, spatial-terrain" together with a probe plugin "test-physics" that reads the spatial series "spatial.terrain"
    And the host has started

  Scenario: A valid position becomes the input "world.position"
    Given "test-physics" published "activity.start-requested"
    And "test-physics" reports the odometer at 12.5 m in a "physics.state-batch"
    When the UI observes the rider at 12 m on 44.660217° N, 5.420908° E, 498.1 m above sea level
    Then "world-driver-ui" accepted the input "world.position" at 12 m on 44.660217° N, 5.420908° E, 498.1 m above sea level
    And no "position-rejected" diagnostic was reported

  Scenario: A position without an altitude is valid
    When the UI observes the rider at 0 m on 44.660217° N, 5.420908° E
    Then "world-driver-ui" accepted the input "world.position" at 0 m on 44.660217° N, 5.420908° E

  Scenario Outline: An invalid position is dropped: <case>
    Given "test-physics" published "activity.start-requested"
    And "test-physics" reports the odometer at 12.5 m in a "physics.state-batch"
    When the UI observes the rider at <distance> m on <latitude>° N, <longitude>° E
    Then a "position-rejected" diagnostic says "<reason>"
    And "world-driver-ui" accepted no "world.position"

    Examples:
      | case                  | distance | latitude | longitude | reason                   |
      | behind 0 m            | -1       | 44.66    | 5.42      | invalid-distance         |
      | ahead of the rider    | 13       | 44.66    | 5.42      | distance-ahead-of-rider  |
      | beyond the north pole | 0        | 90.5     | 5.42      | invalid-latitude         |
      | beyond 180° east      | 0        | 44.66    | 180.5     | invalid-longitude        |
