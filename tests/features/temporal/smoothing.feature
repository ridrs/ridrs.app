@phase-4 @fake-timers
Feature: Time-weighted averages
  Smoothing is defined over time, not over packets, so it does not depend on how
  often a sensor sends. Missing data is excluded and reported as coverage.

  Background:
    Given the capability contracts:
      | capability  | cardinality |
      | demo.signal | single      |
    And the probe plugin "test-reader" reads the temporal series "demo.signal"

  Scenario Outline: Averaging a hold series (<case>)
    Given the probe plugin "test-source" writes the temporal series "demo.signal" with the strategy "hold"
    And the host has started
    And "test-source" recorded the value 100 every 1000 ms from "+0 ms" to "+4000 ms"
    And "test-source" recorded the value 200 every 1000 ms from "+5000 ms" to "+9000 ms"
    Then the <window> average of "demo.signal" at "+10000 ms" is <value> with a coverage of <coverage>

    Examples:
      | case                         | window | value | coverage |
      | full window                  | 10 s   | 150   | 1.00     |
      | short window                 | 4 s    | 200   | 1.00     |
      | window longer than history   | 20 s   | 150   | 0.50     |

  Scenario: The average includes the interpolated and extrapolated parts of a trend series
    Given the probe plugin "test-source" writes the temporal series "demo.signal" with the strategy "damped-trend"
    And the host has started
    And "test-source" recorded:
      | value | measuredAt |
      | 180   | +0 ms      |
      | 190   | +250 ms    |
      | 200   | +500 ms    |
      | 210   | +750 ms    |
    Then the 1 s average of "demo.signal" at "+1000 ms" is 200 with a coverage of 1.00
    And its quality is "extrapolated"

  Scenario: Stale time is excluded from the average
    Given the probe plugin "test-source" writes the temporal series "demo.signal" with the strategy "hold"
    And the host has started
    And "test-source" recorded the value 100 every 1000 ms from "+0 ms" to "+3000 ms"
    Then the 15 s average of "demo.signal" at "+15000 ms" is 100 with a coverage of 0.73
