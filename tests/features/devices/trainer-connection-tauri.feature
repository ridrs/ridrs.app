@phase-3 @fake-timers
Feature: The FTMS trainer over the Tauri BLE transport
  The unchanged device plugin works on top of transport-ble-tauri, driven through a simulated
  Tauri bridge instead of the native app.

  Background:
    Given the host clock shows "10:00:00.000"
    And a simulated Tauri bridge with an FTMS trainer "KICKR CORE 1234"
    And the ridrs plugins "transport-ble-tauri, device-ftms-trainer, metric-power, metric-cadence" running

  Scenario: Power arrives through the Tauri transport
    Given the trainer "KICKR CORE 1234" is connected
    When the trainer sends the Indoor Bike Data packet "45 00 B4 00 C8 00"
    Then the latest "metric.power" is 200 W from the trainer "KICKR CORE 1234" measured at "10:00:00.000"

  Scenario: A lost connection is reported once and the trainer is reconnected by its id
    Given the trainer "KICKR CORE 1234" is connected
    When the trainer "KICKR CORE 1234" drops the connection and refuses new connections
    Then the connection state of "KICKR CORE 1234" is "reconnecting"
    When the trainer "KICKR CORE 1234" accepts connections again
    And 1 second passes
    Then the connection state of "KICKR CORE 1234" is "connected"
    And the simulated Tauri bridge received no new scan request

  Scenario: Stopping the transport user leaves no native subscription behind
    Given the trainer "KICKR CORE 1234" is connected
    When the plugin "device-ftms-trainer" is stopped
    Then the simulated Tauri bridge holds no subscriptions
    And the trainer "KICKR CORE 1234" is no longer connected
