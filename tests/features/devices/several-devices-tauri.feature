@devices @fake-timers
Feature: Several devices over the Tauri BLE transport
  The native BLE layer runs one scan at a time. It ends that scan when it connects a device
  and after two minutes without being asked. A device plugin that is still searching must
  keep finding its device: the trainer connecting first must not stop the search for the
  heart-rate sensor.

  Background:
    Given the host clock shows "10:00:00.000"
    And a simulated Tauri bridge with an FTMS trainer "KICKR CORE 1234"
    And the simulated BLE environment also contains a switched-off heart-rate sensor "HRM-Pro 42"

  Scenario: The heart-rate sensor is found after the trainer connected
    Given the ridrs plugins "transport-ble-tauri, device-ftms-trainer, device-heart-rate" running
    And the trainer "KICKR CORE 1234" is connected
    When the heart-rate sensor "HRM-Pro 42" is switched on
    And 1 second passes
    Then the heart-rate sensor "HRM-Pro 42" is connected
    And the trainer "KICKR CORE 1234" is connected

  Scenario: The search goes on after the native scan timed out
    Given the trainer "KICKR CORE 1234" is switched off
    And the ridrs plugins "transport-ble-tauri, device-ftms-trainer" running
    When 150 seconds pass
    And the trainer "KICKR CORE 1234" is switched on
    And 1 second passes
    Then the connection state of "KICKR CORE 1234" is "connected"
