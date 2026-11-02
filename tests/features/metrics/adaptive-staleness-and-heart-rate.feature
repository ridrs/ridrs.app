@phase-4 @fake-timers
Feature: Heart rate metric and staleness that fits each source
  A metric becomes unavailable when its source falls silent - after a delay that fits
  the source's own rate. With too little history the Phase 2 behavior (3 s) applies.

  Background:
    Given the host clock shows "10:00:00.000"
    And the ridrs plugins "metric-power, metric-cadence, metric-heart-rate" together with a test device plugin "test-device"
    And the host has started

  Scenario: A heart-rate measurement makes the metric available
    When "test-device" publishes a heart-rate measurement of 150 bpm from device "hrm-1"
    Then the latest "metric.heart-rate" is 150 bpm from device "hrm-1" measured at "10:00:00.000"

  Scenario: A 4 Hz power source becomes stale after 2 seconds of silence
    When "test-device" publishes 4 power measurements of 200 W from device "trainer-1" every 0.25 seconds
    And 1.9 seconds pass
    Then the latest "metric.power" is 200 W from device "trainer-1" measured at "10:00:00.750"
    When 0.2 seconds pass
    Then the latest "metric.power" is unavailable because of "stale"
    And exactly one "metric.power" event reporting "unavailable" was published

  Scenario: A 1 Hz heart-rate source is given 8 seconds
    When "test-device" publishes 4 heart-rate measurements of 150 bpm from device "hrm-1" every 1 second
    And 7.9 seconds pass
    Then the latest "metric.heart-rate" is 150 bpm from device "hrm-1" measured at "10:00:03.000"
    When 0.2 seconds pass
    Then the latest "metric.heart-rate" is unavailable because of "stale"

  Scenario: A disconnected heart-rate sensor makes the metric unavailable at once
    Given "test-device" published a heart-rate measurement of 150 bpm from device "hrm-1"
    When "test-device" reports device "hrm-1" as "reconnecting"
    Then the latest "metric.heart-rate" is unavailable because of "disconnected"

  Scenario: Heart rate and power stay independent
    Given "test-device" published a power measurement of 200 W from device "trainer-1"
    When "test-device" reports device "hrm-1" as "disconnected"
    Then the latest "metric.power" is 200 W from device "trainer-1" measured at "10:00:00.000"
