@phase-10 @fake-timers
Feature: The spatial data layer
  Quantities by distance along the path, as the temporal layer holds quantities by time.
  A writer puts windows of samples in; readers ask for the value at any distance. The
  gradient is interpolated linearly, the surface holds from one sample to the next, and
  terrain never goes stale.

  Background:
    Given the probe plugin "test-world" writes the spatial series "spatial.terrain"
    And the probe plugin "test-physics" reads the spatial series "spatial.terrain"
    And the host has started

  Scenario: Before any window there is no terrain
    Then "test-physics" reads no terrain at 0 m, because of "no-source"

  Scenario: Between two samples the gradient is interpolated linearly
    When "test-world" writes revision 1 of the terrain from 0 m, 10 m apart:
      | gradient | surface |
      | 0        | asphalt |
      | 10       | asphalt |
    Then "test-physics" reads at 2.5 m a gradient of 2.5 % on "asphalt" ("interpolated")
    And "test-physics" reads at 10 m a gradient of 10 % on "asphalt" ("sampled")

  Scenario: The surface holds from one sample to the next
    When "test-world" writes revision 1 of the terrain from 0 m, 1 m apart:
      | gradient | surface |
      | 0        | asphalt |
      | 0        | gravel  |
      | 0        | gravel  |
    Then "test-physics" reads at 0.99 m a gradient of 0 % on "asphalt" ("interpolated")
    And "test-physics" reads at 1 m a gradient of 0 % on "gravel" ("sampled")

  Scenario: A newer window replaces the range it covers
    Given "test-world" wrote revision 1 of the terrain from 0 m, 1 m apart:
      | gradient | surface |
      | 0        | asphalt |
      | 0        | asphalt |
      | 0        | asphalt |
    When "test-world" writes revision 2 of the terrain from 1 m, 1 m apart:
      | gradient | surface |
      | 5        | gravel  |
      | 5        | gravel  |
    Then "test-physics" reads at 1.5 m a gradient of 5 % on "gravel" ("interpolated")
    And "test-physics" reads no terrain at 0.5 m, because of "outside-window"

  Scenario: An older revision is ignored
    Given "test-world" wrote revision 2 of the terrain from 0 m, 1 m apart:
      | gradient | surface |
      | 5        | gravel  |
      | 5        | gravel  |
    When "test-world" writes revision 1 of the terrain from 0 m, 1 m apart:
      | gradient | surface |
      | 0        | asphalt |
      | 0        | asphalt |
    Then the spatial write result was "outdated"
    And "test-physics" reads at 0.5 m a gradient of 5 % on "gravel" ("interpolated")

  Scenario: Reading ahead as far as the window goes
    When "test-world" writes revision 1 of the terrain from 0 m, 10 m apart:
      | gradient | surface |
      | 0        | asphalt |
      | 3        | asphalt |
      | 6        | gravel  |
    Then "test-physics" reads at 20 m a gradient of 6 % on "gravel" ("sampled")

  Scenario: Beyond the end of the window the last sample is held
    When "test-world" writes revision 1 of the terrain from 0 m, 10 m apart:
      | gradient | surface |
      | 0        | asphalt |
      | 4        | gravel  |
    Then "test-physics" reads at 500 m a gradient of 4 % on "gravel" ("held")

  Scenario: Terrain does not age at standstill
    Given "test-world" wrote revision 1 of the terrain from 0 m, 10 m apart:
      | gradient | surface |
      | 0        | asphalt |
      | 4        | gravel  |
    When 600 s pass
    Then "test-physics" reads at 5 m a gradient of 2 % on "asphalt" ("interpolated")
