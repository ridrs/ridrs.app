@phase-5 @fake-timers
Feature: Physics as replaceable plugins
  Every physical model is its own plugin behind a capability. Replacing one changes
  the result, not the code; a failing one stops the simulation, not the host.

  Scenario Outline: <plugin> declares exactly what it needs
    Given the ridrs physics plugins together with a probe plugin "test-ui"
    And the host has started
    Then the manifest of "<plugin>" requires exactly "<requires>"

    Examples:
      | plugin                     | requires                                                                       |
      | physics-engine             | physics.motion                                                                 |
      | physics-virtual-speed      | physics.bicycle, physics.powertrain, physics.rider, physics.total-resistance   |
      | physics-total-resistance   | physics.resistance                                                             |
      | physics-rolling-resistance | physics.bicycle                                                                |
      | physics-aerodynamics       | physics.rider                                                                  |
      | physics-powertrain         | metric.power                                                                   |

  Scenario: A different rider changes the speed, not the code
    Given the ridrs physics plugins without "physics-rider" together with a test device plugin "test-device" and a probe plugin "test-ui"
    And a probe plugin "test-rider" provides "physics.rider" with a mass of 95 kg and a CdA of 0.32 m²
    And the host has started
    And "test-ui" published "activity.start-requested"
    When "test-device" delivers only power 200 W every 0.25 s for 10 seconds
    Then the virtual speed at "+10 s" is 20.18 km/h
    And the virtual distance at "+10 s" is 37.63 m

  Scenario: A failing resistance plugin stops the simulation, not the host
    Given the ridrs physics plugins together with a test device plugin "test-device" and a probe plugin "test-ui"
    And a probe plugin "test-broken-resistance" provides "physics.resistance" and throws when evaluated
    And the host has started
    And "test-ui" published "activity.start-requested"
    When "test-device" delivers only power 200 W every 0.25 s for 2 seconds
    Then a "physics-step-failed" diagnostic names the plugin "test-broken-resistance"
    And no physics state was published for this ride
    And the latest "metric.power" is 200 W from device "trainer-1" measured at "10:00:02.000"
