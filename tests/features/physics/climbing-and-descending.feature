@phase-6 @fake-timers
Feature: Same power, different speed on a gradient
  The use case of Phase 6: the measured power is the same, the road is not.

  Background:
    Given the ridrs physics plugins without "physics-road" together with a test device plugin "test-device" and a probe plugin "test-ui"

  Scenario Outline: 200 W for one minute on <gradient> %
    Given a probe plugin "test-road" provides "physics.road" with a constant gradient of <gradient> %
    And the host has started
    And "test-ui" published "activity.start-requested"
    When "test-device" delivers only power 200 W every 0.25 s for 60 seconds
    Then the virtual speed at "+60 s" is <speed> km/h
    And the gradient at "+60 s" is <gradient> %

    Examples:
      | gradient | speed |
      | 0        | 33.87 |
      | 5        | 14.90 |
      | -5       | 57.48 |

  Scenario: Rolling down without pedalling
    Given a probe plugin "test-road" provides "physics.road" with a constant gradient of -5 %
    And the host has started
    And "test-ui" published "activity.start-requested"
    When 60 s pass
    Then the virtual speed at "+10 s" is 15.69 km/h
    And the virtual speed at "+60 s" is 48.27 km/h

  Scenario: Without pedalling on a climb the rider stays at rest
    Given a probe plugin "test-road" provides "physics.road" with a constant gradient of 5 %
    And the host has started
    And "test-ui" published "activity.start-requested"
    When 10 s pass
    Then the virtual speed at "+10 s" is 0.00 km/h
    And the virtual distance at "+10 s" is 0.00 m

  Scenario: Riding from the flat onto a climb
    Given a probe plugin "test-road" provides "physics.road" that is flat for the first 100 m and then climbs at 5 %
    And the host has started
    And "test-ui" published "activity.start-requested"
    When "test-device" delivers only power 200 W every 0.25 s for 60 seconds
    Then the virtual speed at "+10 s" is 22.24 km/h
    And the gradient at "+10 s" is 0 %
    And the virtual speed at "+20 s" is 25.60 km/h
    And the gradient at "+20 s" is 5 %
    And the virtual speed at "+60 s" is 14.93 km/h

  Scenario: The demo course climbs after two kilometres
    Given the plugin "physics-road" is loaded as well
    And the host has started
    And "test-ui" published "activity.start-requested"
    When "test-device" delivers only power 200 W every 0.25 s for 300 seconds
    Then the virtual speed at "+200 s" is 34.22 km/h
    And the gradient at "+200 s" is 0 %
    And the virtual speed at "+300 s" is 14.90 km/h
    And the gradient at "+300 s" is 5 %
    And the virtual distance at "+300 s" is 2375.92 m
