@phase-6 @fake-timers
Feature: Same power, different speed on a gradient
  The use case of Phase 6: the measured power is the same, the road is not. A mock world
  feeds the terrain as the UI landscape's driver does: as inputs, the first one when the ride starts.

  Background:
    Given the ridrs physics plugins together with a test device plugin "test-device" and a probe plugin "test-ui"

  Scenario Outline: 200 W for one minute on <gradient> %
    Given a mock world "test-road" feeds the terrain ahead with a constant gradient of <gradient> % when the ride starts
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

  Scenario: On a descent the rider waits at rest until pedalling starts
    Given a mock world "test-road" feeds the terrain ahead with a constant gradient of -5 % when the ride starts
    And the host has started
    And "test-ui" published "activity.start-requested"
    When 60 s pass
    Then the virtual speed at "+10 s" is 0.00 km/h
    And the virtual speed at "+60 s" is 0.00 km/h
    And the virtual distance at "+60 s" is 0.00 m

  Scenario: A few pedal strokes start the roll down
    Given a mock world "test-road" feeds the terrain ahead with a constant gradient of -5 % when the ride starts
    And the host has started
    And "test-ui" published "activity.start-requested"
    When "test-device" delivers only power 200 W every 0.25 s for 2 seconds
    And 58 seconds pass
    Then the virtual speed at "+10 s" is 26.96 km/h
    And the virtual speed at "+60 s" is 49.13 km/h

  Scenario: Cadence alone starts the roll down
    Given a mock world "test-road" feeds the terrain ahead with a constant gradient of -5 % when the ride starts
    And the host has started
    And "test-ui" published "activity.start-requested"
    When "test-device" delivers only cadence 60 rpm every 0.25 s for 2 seconds
    And 58 seconds pass
    Then the virtual speed at "+10 s" is 15.69 km/h

  Scenario Outline: Too little activity keeps the rider at rest on a descent: <power> W, <cadence> rpm
    Given a mock world "test-road" feeds the terrain ahead with a constant gradient of -5 % when the ride starts
    And the host has started
    And "test-ui" published "activity.start-requested"
    When "test-device" delivers power <power> W and cadence <cadence> rpm every 0.25 s for 10 seconds
    Then the virtual speed at "+10 s" is 0.00 km/h
    And the virtual distance at "+10 s" is 0.00 m

    Examples:
      | power | cadence |
      | 0     | 0       |
      | 29    | 19      |

  Scenario: Without pedalling on a climb the rider stays at rest
    Given a mock world "test-road" feeds the terrain ahead with a constant gradient of 5 % when the ride starts
    And the host has started
    And "test-ui" published "activity.start-requested"
    When 10 s pass
    Then the virtual speed at "+10 s" is 0.00 km/h
    And the virtual distance at "+10 s" is 0.00 m

  Scenario: Riding from the flat onto a climb
    Given a mock world "test-road" feeds the terrain ahead, flat for the first 100 m and then climbing at 5 %, when the ride starts
    And the host has started
    And "test-ui" published "activity.start-requested"
    When "test-device" delivers only power 200 W every 0.25 s for 60 seconds
    Then the virtual speed at "+10 s" is 22.24 km/h
    And the gradient at "+10 s" is 0 %
    # The terrain comes in 1 m samples: the climb ramps in over the metre before 100 m
    # (ADR 0043). With the former step at exactly 100 m this was 25.60 km/h.
    And the virtual speed at "+20 s" is 25.51 km/h
    And the gradient at "+20 s" is 5 %
    And the virtual speed at "+60 s" is 14.93 km/h

  Scenario: The demo course climbs after two kilometres
    Given a mock world "test-landscape" feeds the demo course on asphalt
    And the host has started
    And "test-ui" published "activity.start-requested"
    When "test-device" delivers only power 200 W every 0.25 s for 300 seconds
    Then the virtual speed at "+200 s" is 34.22 km/h
    And the gradient at "+200 s" is 0 %
    And the virtual speed at "+300 s" is 14.90 km/h
    And the gradient at "+300 s" is 5 %
    # 1 m samples: the climb ramps in over the metre before 2000 m (ADR 0043); 2375.92 m before.
    And the virtual distance at "+300 s" is 2375.63 m
