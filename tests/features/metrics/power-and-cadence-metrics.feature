@phase-2 @fake-timers
Feature: Power and cadence metrics
  metric-power and metric-cadence turn measurement events from any device into
  the application-wide metrics "metric.power" and "metric.cadence".
  They never invent values: no data means "unavailable" - never zero, never the last value.

  Background:
    Given the host clock shows "10:00:00.000"
    And the ridrs plugins "metric-power, metric-cadence" together with a test device plugin "test-device"
    And the host has started

  Scenario: Without any measurement the metrics are unavailable
    Then the latest "metric.power" is unavailable because of "no-source"
    And the latest "metric.cadence" is unavailable because of "no-source"

  Scenario: A measurement makes the metric available
    When "test-device" publishes a power measurement of 200 W from device "trainer-1"
    Then the latest "metric.power" is 200 W from device "trainer-1" measured at "10:00:00.000"
    And a "metric.power" event with 200 W was published
    And the latest "metric.cadence" is unavailable because of "no-source"

  Scenario: Zero is a real value
    When "test-device" publishes a cadence measurement of 0 rpm from device "trainer-1"
    Then the latest "metric.cadence" is 0 rpm from device "trainer-1" measured at "10:00:00.000"

  Scenario: A disconnected device makes its metrics unavailable instead of keeping the last value
    Given "test-device" published a power measurement of 200 W from device "trainer-1"
    And "test-device" published a cadence measurement of 90 rpm from device "trainer-1"
    When "test-device" reports device "trainer-1" as "reconnecting"
    Then the latest "metric.power" is unavailable because of "disconnected"
    And the latest "metric.cadence" is unavailable because of "disconnected"
    And exactly one "metric.power" event reporting "unavailable" was published

  Scenario: Metrics return with the first new measurement after reconnection
    Given "test-device" published a power measurement of 200 W from device "trainer-1"
    And "test-device" reported device "trainer-1" as "reconnecting"
    When "test-device" reports device "trainer-1" as "connected"
    And "test-device" publishes a power measurement of 210 W from device "trainer-1"
    Then the latest "metric.power" is 210 W from device "trainer-1" measured at "10:00:00.000"

  Scenario: A silent source becomes stale
    Given "test-device" published a power measurement of 200 W from device "trainer-1"
    When 2.9 seconds pass
    Then the latest "metric.power" is 200 W from device "trainer-1" measured at "10:00:00.000"
    When 0.2 seconds pass
    Then the latest "metric.power" is unavailable because of "stale"
    And exactly one "metric.power" event reporting "unavailable" was published

  Scenario: Each new measurement restarts the staleness timer
    Given "test-device" published a power measurement of 200 W from device "trainer-1"
    When 2 seconds pass
    And "test-device" publishes a power measurement of 205 W from device "trainer-1"
    And 2 seconds pass
    Then the latest "metric.power" is 205 W from device "trainer-1" measured at "10:00:02.000"

  Scenario: The first delivering device stays the source while it is available
    Given "test-device" published a power measurement of 200 W from device "trainer-1"
    When "test-device" publishes a power measurement of 250 W from device "powermeter-1"
    And "test-device" publishes a power measurement of 255 W from device "powermeter-1"
    Then the latest "metric.power" is 200 W from device "trainer-1" measured at "10:00:00.000"
    And the host reported exactly one "multiple-sources" problem for plugin "metric-power" mentioning "powermeter-1"

  Scenario: Another device takes over when the active source is lost
    Given "test-device" published a power measurement of 200 W from device "trainer-1"
    And "test-device" reported device "trainer-1" as "disconnected"
    When "test-device" publishes a power measurement of 250 W from device "powermeter-1"
    Then the latest "metric.power" is 250 W from device "powermeter-1" measured at "10:00:00.000"

  Scenario: Stopping a metric plugin ends its timers
    Given "test-device" published a power measurement of 200 W from device "trainer-1"
    When the plugin "metric-power" is stopped
    And 10 seconds pass
    Then no "metric.power" event was published after the plugin stopped
