@phase-6 @fake-timers
Feature: The road under the rider
  The road plugin tells the gradient at a distance. Until routes exist, it is a
  built-in demo course: flat, a climb, flat, a descent, flat.

  Background:
    Given the ridrs physics plugins together with a probe plugin "test-road-reader" that requires "physics.road"
    And the host has started

  Scenario Outline: The demo course at <distance> m
    Then the road gradient at <distance> m is <gradient> % with the origin "default"

    Examples:
      | distance | gradient |
      | 0        | 0.0      |
      | 1999.99  | 0.0      |
      | 2000     | 5.0      |
      | 2999.99  | 5.0      |
      | 3000     | 0.0      |
      | 3500     | -5.0     |
      | 4500     | 0.0      |
      | 100000   | 0.0      |

  Scenario Outline: <plugin> declares exactly what it needs
    Then the manifest of "<plugin>" requires <requires>

    Examples:
      | plugin                | requires                                                                                          |
      | physics-road          | nothing                                                                                           |
      | physics-environment   | nothing                                                                                           |
      | physics-virtual-speed | exactly "physics.bicycle, physics.powertrain, physics.rider, physics.road, physics.total-resistance" |
