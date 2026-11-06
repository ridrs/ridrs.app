@fake-timers
Feature: A ride with a world starts once the world is ready
  A world such as a video route needs a while to load after the ride started. Until its first
  terrain window of this ride arrives, the rider stands at rest, however hard they pedal; then
  the rider accelerates from standstill, as soon as they pedal. A free ride, without a world,
  starts at once.

  Background:
    Given the ridrs physics plugins together with a test device plugin "test-device" and a probe plugin "test-ui"

  Scenario: Pedalling while the world loads does not move the rider
    Given a mock world "test-world" feeds the terrain ahead with a constant gradient of 0 % 3 s after the ride starts
    And the host has started
    And "test-ui" asks to start a ride on the landscape "test-world/landscape" along the route "test-route"
    When "test-device" delivers only power 200 W every 0.25 s for 13 seconds
    Then the virtual speed at "+3 s" is 0.00 km/h
    And the virtual distance at "+3 s" is 0.00 m
    And the virtual speed at "+13 s" is 22.24 km/h
    And no "terrain-preview-missing" diagnostic was reported

  Scenario: On a descent the rider still waits for pedalling once the world is ready
    Given a mock world "test-world" feeds the terrain ahead with a constant gradient of -5 % 3 s after the ride starts
    And the host has started
    And "test-ui" asks to start a ride on the landscape "test-world/landscape" along the route "test-route"
    When 13 seconds pass
    Then the virtual speed at "+13 s" is 0.00 km/h
    And the virtual distance at "+13 s" is 0.00 m

  Scenario: The window of the previous ride does not make the world ready
    Given a mock world "test-world" feeds the terrain ahead with a constant gradient of 0 % 1 s after the ride starts
    And the host has started
    And "test-ui" asks to start a ride on the landscape "test-world/landscape" along the route "test-route"
    And "test-device" delivered only power 200 W every 0.25 s for 2 seconds
    And "test-ui" published "activity.finish-requested"
    When "test-ui" asks to start a ride on the landscape "test-world/landscape" along the route "test-route"
    And "test-device" delivers only power 200 W every 0.25 s for 3 more seconds
    Then the virtual speed at "+3 s" is 0.00 km/h
    And the virtual distance at "+3 s" is 0.00 m
    And the virtual speed at "+5 s" is 10.23 km/h
