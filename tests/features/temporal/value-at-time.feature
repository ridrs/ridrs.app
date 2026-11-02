@phase-4 @fake-timers
Feature: The value of a source at a given time
  Between measurements values are interpolated, after the last one they are
  extrapolated with a decaying trend, then held, and finally reported as stale.
  Estimates are always labelled - they never look like measurements.

  Background:
    Given the capability contracts:
      | capability  | cardinality |
      | demo.signal | single      |
      | demo.held   | single      |
    And the probe plugin "test-source" writes the temporal series "demo.signal" with the strategy "damped-trend"
    And the probe plugin "test-held-source" writes the temporal series "demo.held" with the strategy "hold"
    And the probe plugin "test-reader" reads the temporal series "demo.signal, demo.held"
    And the host has started

  Scenario Outline: A rising signal over time (<phase>)
    Given "test-source" recorded:
      | value | measuredAt |
      | 180   | +0 ms      |
      | 190   | +250 ms    |
      | 200   | +500 ms    |
      | 210   | +750 ms    |
    Then the value of "demo.signal" at "<at>" is <value> "<quality>"

    Examples:
      | phase                         | at       | value  | quality      |
      | at a measurement              | +500 ms  | 200    | measured     |
      | between two measurements      | +625 ms  | 205    | interpolated |
      | one interval ahead            | +1000 ms | 220    | extrapolated |
      | trend decaying                | +1250 ms | 226.32 | extrapolated |
      | end of extrapolation          | +1500 ms | 228.65 | extrapolated |
      | held after three intervals    | +2000 ms | 228.65 | held         |

  Scenario: A silent source becomes stale after a delay that fits its rate
    Given "test-source" recorded:
      | value | measuredAt |
      | 180   | +0 ms      |
      | 190   | +250 ms    |
      | 200   | +500 ms    |
      | 210   | +750 ms    |
    When the clock reaches "+3000 ms"
    Then the freshness changes of "demo.signal" were:
      | freshness | at       |
      | fresh     | +0 ms    |
      | delayed   | +1125 ms |
      | stale     | +2750 ms |
    And the value of "demo.signal" at "+2749 ms" is 228.65 "held"
    And the value of "demo.signal" at "+2750 ms" is unavailable because of "stale"

  Scenario: A falling signal is damped the same way
    Given "test-source" recorded:
      | value | measuredAt |
      | 210   | +0 ms      |
      | 200   | +250 ms    |
      | 190   | +500 ms    |
      | 180   | +750 ms    |
    Then the value of "demo.signal" at "+1500 ms" is 161.35 "extrapolated"

  Scenario: Extrapolation never goes below zero
    Given "test-source" recorded:
      | value | measuredAt |
      | 30    | +0 ms      |
      | 20    | +250 ms    |
      | 10    | +500 ms    |
      | 0     | +750 ms    |
    Then the value of "demo.signal" at "+1000 ms" is 0 "extrapolated"

  Scenario: Without a learned interval there is no trend
    Given "test-source" recorded:
      | value | measuredAt |
      | 200   | +0 ms      |
      | 300   | +250 ms    |
    Then the value of "demo.signal" at "+500 ms" is 300 "held"

  Scenario: After a stale period the old trend is not continued
    Given "test-source" recorded:
      | value | measuredAt |
      | 180   | +0 ms      |
      | 190   | +250 ms    |
      | 200   | +500 ms    |
      | 210   | +750 ms    |
    And the clock reached "+3000 ms"
    When "test-source" records:
      | value | measuredAt |
      | 300   | +5000 ms   |
    Then the freshness of "demo.signal" is "fresh"
    And the value of "demo.signal" at "+5000 ms" is 300 "measured"
    And the value of "demo.signal" at "+5100 ms" is 300 "held"
    And the value of "demo.signal" at "+4000 ms" is unavailable because of "stale"

  Scenario: Nothing is invented across a disconnect
    Given "test-source" recorded:
      | value | measuredAt |
      | 180   | +0 ms      |
      | 190   | +250 ms    |
      | 200   | +500 ms    |
      | 210   | +750 ms    |
    When "test-source" marks "demo.signal" as disconnected at "+900 ms"
    Then the value of "demo.signal" at "+800 ms" is 212 "extrapolated"
    And the value of "demo.signal" at "+900 ms" is unavailable because of "disconnected"
    And the freshness of "demo.signal" is "disconnected"

  Scenario: A hold series keeps the last value and steps between measurements
    Given "test-held-source" recorded:
      | value | measuredAt |
      | 180   | +0 ms      |
      | 190   | +250 ms    |
      | 200   | +500 ms    |
      | 210   | +750 ms    |
    Then the value of "demo.held" at "+625 ms" is 200 "held"
    And the value of "demo.held" at "+1000 ms" is 210 "held"

  Scenario: Times outside the history are out of range
    Given "test-source" recorded one value every 1000 ms from "+0 ms" to "+70000 ms"
    Then the value of "demo.signal" at "+5000 ms" is unavailable because of "out-of-range"
    And the history of "demo.signal" holds 61 measurements

  Scenario: A series without any measurement has no source
    Then the value of "demo.signal" at "+0 ms" is unavailable because of "no-source"
    And the freshness of "demo.signal" is "none"
