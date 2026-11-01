@phase-2 @fake-timers
Feature: From trainer to metrics
  Real plugins wired only through contracts: bytes from the trainer become
  device-agnostic power and cadence metrics.

  Background:
    Given a simulated BLE environment with an FTMS trainer "KICKR CORE 1234"
    And the ridrs plugins "device-ftms-trainer, metric-power, metric-cadence" running with the simulated BLE central
    And the trainer "KICKR CORE 1234" is connected

  Scenario: Pedalling on the trainer updates power and cadence
    Given the host clock shows "10:00:00.000"
    When the trainer sends the Indoor Bike Data packet "45 00 B4 00 C8 00"
    Then the latest "metric.power" is 200 W from the trainer "KICKR CORE 1234" measured at "10:00:00.000"
    And the latest "metric.cadence" is 90 rpm from the trainer "KICKR CORE 1234" measured at "10:00:00.000"

  Scenario: Losing the trainer makes both metrics unavailable
    Given the trainer sends the Indoor Bike Data packet "45 00 B4 00 C8 00"
    When the trainer "KICKR CORE 1234" drops the connection and refuses new connections
    Then the latest "metric.power" is unavailable because of "disconnected"
    And the latest "metric.cadence" is unavailable because of "disconnected"

  Scenario: The metric plugins know nothing about the device plugin
    Then the manifest of "metric-power" requires no capability
    And the manifest of "metric-cadence" requires no capability
    And the manifest of "device-ftms-trainer" requires exactly "ble.central"
