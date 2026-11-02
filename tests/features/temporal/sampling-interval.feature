@phase-4 @fake-timers
Feature: Learning the sampling interval of a source
  The temporal data layer learns how often a source delivers - from receive times,
  robust against jitter and single gaps, and adapting to a sustained change.

  Background:
    Given the capability contracts:
      | capability  | cardinality |
      | demo.signal | single      |
    And the probe plugin "test-source" writes the temporal series "demo.signal" with the strategy "hold"
    And the probe plugin "test-reader" reads the temporal series "demo.signal"
    And the host has started

  Scenario: Three measurements are not enough to learn an interval
    When "test-source" records:
      | value | measuredAt |
      | 100   | +0 ms      |
      | 100   | +250 ms    |
      | 100   | +500 ms    |
    Then the sampling interval of "demo.signal" is unknown
    And the freshness of "demo.signal" at "+3499 ms" is "fresh"
    And the freshness of "demo.signal" at "+3500 ms" is "stale"

  Scenario: A regular source is learned after four measurements
    When "test-source" records:
      | value | measuredAt |
      | 100   | +0 ms      |
      | 100   | +250 ms    |
      | 100   | +500 ms    |
      | 100   | +750 ms    |
    Then the sampling interval of "demo.signal" is 250 ms
    And the next measurement of "demo.signal" is expected at "+1000 ms"

  Scenario: Jitter does not disturb the learned interval
    When "test-source" records:
      | value | measuredAt |
      | 100   | +0 ms      |
      | 100   | +240 ms    |
      | 100   | +510 ms    |
      | 100   | +760 ms    |
      | 100   | +990 ms    |
      | 100   | +1260 ms   |
    Then the sampling interval of "demo.signal" is 250 ms

  Scenario: A single gap is not learned as a new interval
    When "test-source" records:
      | value | measuredAt |
      | 100   | +0 ms      |
      | 100   | +250 ms    |
      | 100   | +500 ms    |
      | 100   | +750 ms    |
      | 100   | +1000 ms   |
      | 100   | +2000 ms   |
      | 100   | +2250 ms   |
      | 100   | +2500 ms   |
    Then the sampling interval of "demo.signal" is 250 ms

  Scenario: A sustained slower rate replaces the interval after three intervals
    When "test-source" records:
      | value | measuredAt |
      | 100   | +0 ms      |
      | 100   | +250 ms    |
      | 100   | +500 ms    |
      | 100   | +750 ms    |
      | 100   | +1750 ms   |
      | 100   | +2750 ms   |
    Then the sampling interval of "demo.signal" is 250 ms
    When "test-source" records:
      | value | measuredAt |
      | 100   | +3750 ms   |
    Then the sampling interval of "demo.signal" is 1000 ms

  Scenario: A moderate rate change is followed gradually
    When "test-source" records one value every 250 ms from "+0 ms" to "+1000 ms"
    And "test-source" records one value every 500 ms from "+1500 ms" to "+3000 ms"
    Then the sampling interval of "demo.signal" is 375 ms
    When "test-source" records:
      | value | measuredAt |
      | 100   | +3500 ms   |
    Then the sampling interval of "demo.signal" is 500 ms

  Scenario: The interval is learned from receive times, not from the measurement delay
    When "test-source" records:
      | value | measuredAt | receivedAt |
      | 100   | +0 ms      | +100 ms    |
      | 100   | +250 ms    | +350 ms    |
      | 100   | +500 ms    | +600 ms    |
      | 100   | +750 ms    | +850 ms    |
    Then the sampling interval of "demo.signal" is 250 ms
    And the next measurement of "demo.signal" is expected at "+1100 ms"
