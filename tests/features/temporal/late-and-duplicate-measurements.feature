@phase-4 @fake-timers
Feature: Late and duplicate measurements
  The current state never moves backwards in time.

  Background:
    Given the capability contracts:
      | capability  | cardinality |
      | demo.signal | single      |
    And the probe plugin "test-source" writes the temporal series "demo.signal" with the strategy "damped-trend"
    And the probe plugin "test-reader" reads the temporal series "demo.signal"
    And the probe plugin "test-reader" combines "demo.signal"
    And the host has started
    And "test-source" recorded:
      | value | measuredAt |
      | 180   | +0 ms      |
      | 190   | +250 ms    |
      | 200   | +500 ms    |
      | 210   | +750 ms    |

  Scenario: A late measurement is rejected and reported
    When "test-source" records:
      | value | measuredAt | receivedAt |
      | 205   | +600 ms    | +800 ms    |
    Then the record result was "late"
    And the host reported a "late-measurement" problem for plugin "test-source" mentioning "demo.signal"
    And the value of "demo.signal" at "+600 ms" is 204 "interpolated"
    And the sampling interval of "demo.signal" is 250 ms
    And "test-reader" received 4 snapshots

  Scenario: A duplicate measurement is ignored silently
    When "test-source" records:
      | value | measuredAt | receivedAt |
      | 210   | +750 ms    | +760 ms    |
    Then the record result was "duplicate"
    And the host reported no problems
    And "test-reader" received 4 snapshots
    And the next measurement of "demo.signal" is expected at "+1000 ms"
