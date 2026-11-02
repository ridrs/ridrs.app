@phase-5 @fake-timers
Feature: Virtual speed from rider power
  Measured rider power drives a virtual rider of 85 kg on a flat road in still air.
  The speed follows the power, settles where drive and resistance balance, and
  never becomes negative.

  Background:
    Given the ridrs physics plugins together with a test device plugin "test-device" and a probe plugin "test-ui"
    And the host has started
    And "test-ui" published "activity.start-requested"

  Scenario Outline: Riding 200 W from standstill (<moment>)
    When "test-device" delivers only power 200 W every 0.25 s for <seconds> seconds
    Then the virtual speed at "+<seconds> s" is <speed> km/h
    And the virtual distance at "+<seconds> s" is <distance> m

    Examples:
      | moment             | seconds | speed | distance |
      | after one second   | 1       | 6.84  | 1.08     |
      | after ten seconds  | 10      | 22.24 | 41.94    |
      | after one minute   | 60      | 33.87 | 472.40   |

  Scenario: 200 W settles where drive and resistance balance
    When "test-device" delivers only power 200 W every 0.25 s for 180 seconds
    Then the virtual speed at "+180 s" is 34.22 km/h
    And the acceleration at "+180 s" is 0.00 m/s²

  Scenario Outline: More power, more speed (<power> W)
    When "test-device" delivers only power <power> W every 0.25 s for 10 seconds
    Then the virtual speed at "+10 s" is <speed> km/h

    Examples:
      | power | speed |
      | 100   | 15.58 |
      | 300   | 27.18 |

  Scenario: Zero watts keep the rider at rest
    When "test-device" delivers only power 0 W every 0.25 s for 10 seconds
    Then the virtual speed at "+10 s" is 0.00 km/h
    And the virtual distance at "+10 s" is 0.00 m

  Scenario: When pedalling stops, the rider coasts to a halt and stays there
    Given "test-device" delivered only power 200 W every 0.25 s for 60 seconds
    When 30 s pass
    Then the virtual speed at "+62 s" is 33.91 km/h
    And the virtual speed at "+90 s" is 18.39 km/h
    When 110 s pass
    Then the virtual speed at "+184 s" is 0.00 km/h
    And the virtual distance at "+184 s" is 887.22 m
    And the virtual speed at "+200 s" is 0.00 km/h
    And the virtual distance at "+200 s" is 887.22 m
