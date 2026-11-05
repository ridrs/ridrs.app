@devices @fake-timers
Feature: ridrs shows the battery level of a device
  A device with the Battery Service tells its battery level: ridrs reads it when the device
  connects and follows its notifications. The device status gives the level of the device of each
  kind; a device without the service has none.

  Background:
    Given a simulated BLE environment with a heart-rate sensor "HRM-Pro 42"

  Scenario: The battery level is read when the device connects
    Given the heart-rate sensor "HRM-Pro 42" has a battery at 80 %
    When the ridrs plugins "device-registry, device-heart-rate" running with the simulated BLE central
    Then the heart-rate sensor "HRM-Pro 42" is connected
    And the device status gives the "heart-rate" a battery of 80 %

  Scenario: The battery level follows the device
    Given the heart-rate sensor "HRM-Pro 42" has a battery at 80 %
    And the ridrs plugins "device-registry, device-heart-rate" running with the simulated BLE central
    When the heart-rate sensor "HRM-Pro 42" has a battery at 79 %
    Then the device status gives the "heart-rate" a battery of 79 %

  Scenario: A device without a battery has no battery level
    When the ridrs plugins "device-registry, device-heart-rate" running with the simulated BLE central
    Then the heart-rate sensor "HRM-Pro 42" is connected
    And the device status gives the "heart-rate" no battery level

  Scenario: Another device does not take over the battery level
    Given the simulated BLE environment also contains a heart-rate sensor "Polar H10 A1B2"
    And the heart-rate sensor "HRM-Pro 42" has a battery at 80 %
    And the ridrs plugins "device-registry, device-heart-rate" running with the simulated BLE central
    And the device setup looks for devices
    When the rider connects the "heart-rate" "Polar H10 A1B2"
    Then the heart-rate sensor "Polar H10 A1B2" is connected
    And the device status gives the "heart-rate" no battery level
