@phase-4 @fake-timers
Feature: Power-to-heart-rate ratio from time-aligned values
  The ratio divides the 10 s average power by the 10 s average heart rate, both
  evaluated at the same time - although heart rate arrives four times less often.

  Background:
    Given the host clock shows "10:00:00.000"
    And the ridrs plugins "metric-power, metric-heart-rate, metric-power-heart-rate-ratio" together with a test device plugin "test-device"
    And the host has started

  Scenario: The ratio warms up before it is shown
    When "test-device" delivers power 200 W every 0.25 s and heart rate 150 bpm every 1 s for 7 seconds
    Then the latest "metric.power-heart-rate-ratio" is unavailable because of "insufficient-data"
    When "test-device" delivers power 200 W every 0.25 s and heart rate 150 bpm every 1 s for 1 more second
    Then the latest "metric.power-heart-rate-ratio" is 1.33 W/bpm

  Scenario: A change in power is weighted by time
    When "test-device" delivers power 200 W every 0.25 s and heart rate 150 bpm every 1 s for 9.75 seconds
    And "test-device" delivers power 280 W every 0.25 s and heart rate 150 bpm every 1 s for 5.25 more seconds
    Then the latest "metric.power-heart-rate-ratio" is 1.61 W/bpm

  Scenario: A silent heart-rate sensor makes the ratio unavailable
    Given "test-device" delivered power 200 W every 0.25 s and heart rate 150 bpm every 1 s for 12 seconds
    When "test-device" delivers only power 200 W every 0.25 s for 10 more seconds
    Then the latest "metric.heart-rate" is unavailable because of "stale"
    And the latest "metric.power-heart-rate-ratio" is unavailable because of "stale"
    And the latest "metric.power" is 200 W from device "trainer-1" measured at "10:00:22.000"

  Scenario: A disconnected trainer makes the ratio unavailable at once
    Given "test-device" delivered power 200 W every 0.25 s and heart rate 150 bpm every 1 s for 12 seconds
    When "test-device" reports device "trainer-1" as "reconnecting"
    Then the latest "metric.power-heart-rate-ratio" is unavailable because of "disconnected"

  Scenario: The ratio plugin knows only metrics
    Then the manifest of "metric-power-heart-rate-ratio" requires exactly "metric.heart-rate, metric.power"
