@phase-5 @fake-timers
Feature: Resistance forces
  Each resistance is its own plugin and returns a signed force in newtons along the
  direction of travel - positive opposes motion. The total adds them up and keeps
  every contribution inspectable.

  Background:
    Given the ridrs physics plugins together with a probe plugin "test-physics" that requires "physics.total-resistance, physics.bicycle, physics.rider"
    And the host has started

  Scenario Outline: Forces at <speed> m/s with 85 kg
    When "test-physics" evaluates the total resistance at <speed> m/s with a mass of 85 kg
    Then the contribution of "physics-rolling-resistance" is <rolling> N
    And the contribution of "physics-aerodynamics" is <aero> N
    And the total resistance is <total> N

    Examples:
      | speed | rolling | aero  | total |
      | 0     | 0.00    | 0.00  | 0.00  |
      | 5     | 3.34    | 4.90  | 8.24  |
      | 10    | 3.34    | 19.60 | 22.94 |

  Scenario: Rolling resistance grows with the moving mass
    When "test-physics" evaluates the total resistance at 10 m/s with a mass of 105 kg
    Then the contribution of "physics-rolling-resistance" is 4.12 N
    And the contribution of "physics-aerodynamics" is 19.60 N

  Scenario: Contributions are listed in a stable order
    When "test-physics" evaluates the total resistance at 10 m/s with a mass of 85 kg
    Then the contributions are "physics-aerodynamics, physics-gravity-resistance, physics-rolling-resistance" in this order

  Scenario: Default parameters are labelled as defaults
    Then the bicycle parameters are a mass of 10 kg and a rolling resistance coefficient of 0.004, all with the origin "default"
    And the rider parameters are a mass of 75 kg and a CdA of 0.32 m², all with the origin "default"
