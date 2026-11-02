@phase-6 @fake-timers
Feature: The environment provides the air
  Air density comes from the environment plugin; aerodynamics has no fallback of its own.

  Scenario: The default air is labelled as a default
    Given the ridrs physics plugins together with a probe plugin "test-physics" that requires "physics.total-resistance, physics.environment"
    And the host has started
    Then the environment parameters are an air density of 1.225 kg/m³, all with the origin "default"
    And the manifest of "physics-aerodynamics" requires exactly "physics.environment, physics.rider"

  Scenario: Thinner air means less drag
    Given the ridrs physics plugins without "physics-environment" together with a probe plugin "test-physics" that requires "physics.total-resistance"
    And a probe plugin "test-environment" provides "physics.environment" with an air density of 1.0 kg/m³
    And the host has started
    When "test-physics" evaluates the total resistance at 10 m/s with a mass of 85 kg
    Then the contribution of "physics-aerodynamics" is 16.00 N

  Scenario: Thinner air means a little more speed
    Given the ridrs physics plugins without "physics-environment" together with a test device plugin "test-device" and a probe plugin "test-ui"
    And a probe plugin "test-environment" provides "physics.environment" with an air density of 1.0 kg/m³
    And the host has started
    And "test-ui" published "activity.start-requested"
    When "test-device" delivers only power 200 W every 0.25 s for 10 seconds
    Then the virtual speed at "+10 s" is 22.46 km/h

  Scenario: An invalid air density stops the simulation, not the host
    Given the ridrs physics plugins without "physics-environment" together with a test device plugin "test-device" and a probe plugin "test-ui"
    And a probe plugin "test-environment" provides "physics.environment" with an air density of 0 kg/m³
    And the host has started
    When "test-ui" publishes "activity.start-requested"
    Then a "physics-step-failed" diagnostic names the plugin "physics-aerodynamics"
    And no physics state was published for this ride
