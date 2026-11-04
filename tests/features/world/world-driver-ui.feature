@phase-10 @fake-timers
Feature: The UI landscape's terrain enters through a driver
  The UI landscape is a sensor: it publishes the terrain it shows ahead as the raw event
  "ui.terrain-observed". The driver "world-driver-ui" validates every window and accepts
  a valid one as the external input "world.terrain-preview"; an invalid one is dropped
  and reported. The writer "spatial-terrain" puts each accepted window into the spatial
  layer, on asphalt where the window names no surface.

  Background:
    Given the ridrs plugins "activity-session, world-driver-ui, spatial-terrain" together with a probe plugin "test-physics" that reads the spatial series "spatial.terrain"
    And the host has started

  Scenario: A valid window becomes the input "world.terrain-preview"
    When the UI observes revision 1 of the terrain from 0 m, 1 m apart, with the gradients "0, 5" % on "asphalt, gravel"
    Then "world-driver-ui" accepted the input "world.terrain-preview" with revision 1 from 0 m
    And "test-physics" reads at 1 m a gradient of 5 % on "gravel" ("sampled")
    And no "terrain-preview-rejected" diagnostic was reported

  Scenario: A window without surfaces rides on asphalt
    When the UI observes revision 1 of the terrain from 0 m, 1 m apart, with the gradients "0, 5" %
    Then "world-driver-ui" accepted the input "world.terrain-preview" with revision 1 from 0 m
    And "test-physics" reads at 1 m a gradient of 5 % on "asphalt" ("sampled")

  Scenario: During a ride a window may start at or behind the odometer
    Given "test-physics" published "activity.start-requested"
    And "test-physics" reports the odometer at 12.5 m in a "physics.state-batch"
    When the UI observes revision 1 of the terrain from 12 m, 1 m apart, with the gradients "0, 0" % on "asphalt, asphalt"
    Then "world-driver-ui" accepted the input "world.terrain-preview" with revision 1 from 12 m

  Scenario: After a ride the odometer counts as 0 m again
    Given "test-physics" published "activity.start-requested"
    And "test-physics" reports the odometer at 12.5 m in a "physics.state-batch"
    And "test-physics" published "activity.finish-requested"
    When the UI observes revision 1 of the terrain from 12 m, 1 m apart, with the gradients "0, 0" % on "asphalt, asphalt"
    Then a "terrain-preview-rejected" diagnostic says "origin-ahead-of-rider" for revision 1
    And "world-driver-ui" accepted no "world.terrain-preview"

  Scenario Outline: An invalid window is dropped: <case>
    Given "test-physics" published "activity.start-requested"
    And "test-physics" reports the odometer at 12.5 m in a "physics.state-batch"
    And the UI observed revision 1 of the terrain from 0 m, 1 m apart, with the gradients "0, 0" % on "asphalt, asphalt"
    When the UI observes revision <revision> of the terrain from <origin> m, <spacing> m apart, with the gradients "<gradients>" % on "<surfaces>"
    Then a "terrain-preview-rejected" diagnostic says "<reason>" for revision <revision>
    And "world-driver-ui" accepted 1 "world.terrain-preview"
    And "test-physics" reads at 0.5 m a gradient of 0 % on "asphalt" ("interpolated")

    Examples:
      | case                      | revision | origin | spacing | gradients | surfaces         | reason                 |
      | origin behind 0 m         | 2        | -1     | 1       | 0, 0      | asphalt, asphalt | invalid-origin         |
      | origin ahead of the rider | 2        | 13     | 1       | 0, 0      | asphalt, asphalt | origin-ahead-of-rider  |
      | no spacing                | 2        | 0      | 0       | 0, 0      | asphalt, asphalt | invalid-spacing        |
      | a single sample           | 2        | 0      | 1       | 0         | asphalt          | too-few-samples        |
      | steeper than 30 %         | 2        | 0      | 1       | 0, 31     | asphalt, asphalt | invalid-gradient       |
      | steeper than -30 %        | 2        | 0      | 1       | 0, -30.5  | asphalt, asphalt | invalid-gradient       |
      | an unknown surface        | 2        | 0      | 1       | 0, 0      | asphalt, sand    | unknown-surface        |
      | the same revision         | 1        | 0      | 1       | 5, 5      | gravel, gravel   | revision-not-ascending |
      | an older revision         | 0        | 0      | 1       | 5, 5      | gravel, gravel   | revision-not-ascending |
