@phase-6 @fake-timers
Feature: Gravity on a gradient
  On a gradient, gravity pulls along the road: it opposes the rider uphill and
  supports them downhill. Rolling resistance shrinks by cos θ. Positive opposes motion.

  Background:
    Given the ridrs physics plugins together with a probe plugin "test-physics" that requires "physics.total-resistance, physics.bicycle, physics.rider"
    And the host has started

  Scenario Outline: Forces at 5 m/s with 85 kg on <gradient> %
    When "test-physics" evaluates the total resistance at 5 m/s with a mass of 85 kg on a gradient of <gradient> %
    Then the contribution of "physics-gravity-resistance" is <gravity> N
    And the contribution of "physics-rolling-resistance" is <rolling> N
    And the contribution of "physics-aerodynamics" is 4.90 N
    And the total resistance is <total> N

    Examples:
      | gradient | gravity | rolling | total  |
      | 0        | 0.00    | 3.34    | 8.24   |
      | 5        | 41.64   | 3.33    | 49.87  |
      | -5       | -41.64  | 3.33    | -33.41 |

  Scenario: Gravity acts at standstill, rolling resistance does not
    When "test-physics" evaluates the total resistance at 0 m/s with a mass of 85 kg on a gradient of 5 %
    Then the contribution of "physics-gravity-resistance" is 41.64 N
    And the contribution of "physics-rolling-resistance" is 0.00 N
    And the total resistance is 41.64 N

  Scenario: The gravity plugin needs no provider
    Then the manifest of "physics-gravity-resistance" requires nothing
