@phase-4 @fake-timers
Feature: Time-aligned snapshots across sources with different rates
  Every actual measurement of any combined source produces exactly one snapshot,
  in which all sources are evaluated at the same time. Nobody waits for the slower source.

  Background:
    Given the capability contracts:
      | capability      | cardinality |
      | demo.power      | single      |
      | demo.heart-rate | single      |
    And the probe plugin "test-power" writes the temporal series "demo.power" with the strategy "damped-trend"
    And the probe plugin "test-heart-rate" writes the temporal series "demo.heart-rate" with the strategy "hold"
    And the probe plugin "test-consumer" combines "demo.power, demo.heart-rate"
    And the host has started
    And these measurements were recorded:
      | series          | value | measuredAt |
      | demo.power      | 180   | +0 ms      |
      | demo.heart-rate | 150   | +100 ms    |
      | demo.power      | 190   | +250 ms    |
      | demo.power      | 200   | +500 ms    |
      | demo.power      | 210   | +750 ms    |
      | demo.power      | 220   | +1000 ms   |
      | demo.heart-rate | 152   | +1100 ms   |

  Scenario: One snapshot per actual measurement, at its measurement time
    Then "test-consumer" received the snapshots:
      | at       | trigger         |
      | +0 ms    | demo.power      |
      | +100 ms  | demo.heart-rate |
      | +250 ms  | demo.power      |
      | +500 ms  | demo.power      |
      | +750 ms  | demo.power      |
      | +1000 ms | demo.power      |
      | +1100 ms | demo.heart-rate |

  Scenario: The slower source is estimated at the trigger time
    Then the snapshot of "test-consumer" at "+750 ms" contains:
      | series          | status    | value | quality  | sourceMeasuredAt |
      | demo.power      | available | 210   | measured | +750 ms          |
      | demo.heart-rate | available | 150   | held     | +100 ms          |

  Scenario: The faster source is extrapolated when the slower one triggers
    Then the snapshot of "test-consumer" at "+1100 ms" contains:
      | series          | status    | value | quality      | sourceMeasuredAt |
      | demo.heart-rate | available | 152   | measured     | +1100 ms         |
      | demo.power      | available | 224   | extrapolated | +1000 ms         |

  Scenario: A source without data is part of the snapshot as unavailable
    Then the snapshot of "test-consumer" at "+0 ms" contains:
      | series          | status      | reason    |
      | demo.power      | available   |           |
      | demo.heart-rate | unavailable | no-source |

  Scenario: No snapshots are invented while sources are silent
    When 10 seconds pass
    Then "test-consumer" received 7 snapshots

  Scenario: A snapshot can be requested for any past time without side effects
    When "test-consumer" requests a snapshot at "+900 ms"
    Then that snapshot contains:
      | series          | status    | value | quality      |
      | demo.power      | available | 216   | interpolated |
      | demo.heart-rate | available | 150   | held         |
    And it has no trigger
    And "test-consumer" received 7 snapshots

  Scenario: A stopped consumer receives no more snapshots
    When the plugin "test-consumer" is stopped
    And these measurements are recorded:
      | series     | value | measuredAt |
      | demo.power | 230   | +1250 ms   |
    Then "test-consumer" received 7 snapshots
