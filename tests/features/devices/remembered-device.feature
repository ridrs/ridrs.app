@devices @fake-timers
Feature: ridrs remembers the device of each kind across restarts
  The device that connected last is remembered per kind in the machine's settings (ADR 0054).
  After a restart it is the only device of the kind that connects on its own, as soon as it is
  found; with several devices of a kind in a room, the rider's own connects again, not the first
  one found. A forgotten device stays forgotten after a restart: no device of the kind connects on
  its own until the device setup opens.

  Background:
    Given a simulated BLE environment with a heart-rate sensor "HRM-Pro 42"
    And the simulated BLE environment also contains a heart-rate sensor "Polar H10 A1B2"
    And the ridrs plugins "device-registry, device-heart-rate" running with the simulated BLE central

  Scenario: The device the rider connected connects again after a restart
    Given the device setup looks for devices
    And the rider connects the "heart-rate" "Polar H10 A1B2"
    And the heart-rate sensor "Polar H10 A1B2" is connected
    When ridrs restarts
    Then the heart-rate sensor "Polar H10 A1B2" is connected
    And the heart-rate sensor "HRM-Pro 42" is not connected
    And the device status is:
      | kind       | state     | device         |
      | heart-rate | connected | Polar H10 A1B2 |

  Scenario: The first device found is remembered once it connected
    Given the heart-rate sensor "HRM-Pro 42" is connected
    When ridrs restarts
    Then the heart-rate sensor "HRM-Pro 42" is connected
    And the heart-rate sensor "Polar H10 A1B2" is not connected

  Scenario: While the remembered device is away, no other device of the kind connects on its own
    Given the device setup looks for devices
    And the rider connects the "heart-rate" "Polar H10 A1B2"
    And the heart-rate sensor "Polar H10 A1B2" is connected
    And the heart-rate sensor "Polar H10 A1B2" is switched off
    When ridrs restarts
    And 60 seconds pass
    Then the heart-rate sensor "HRM-Pro 42" is not connected
    And the device status lists the "heart-rate" devices "HRM-Pro 42"
    When the heart-rate sensor "Polar H10 A1B2" is switched on
    Then the heart-rate sensor "Polar H10 A1B2" is connected
    And the heart-rate sensor "HRM-Pro 42" is not connected

  Scenario: The rider connects another device instead of the remembered one
    Given the heart-rate sensor "HRM-Pro 42" is connected
    And ridrs restarted
    When the device setup looks for devices
    And the rider connects the "heart-rate" "Polar H10 A1B2"
    And ridrs restarts
    Then the heart-rate sensor "Polar H10 A1B2" is connected
    And the heart-rate sensor "HRM-Pro 42" is not connected

  Scenario: A forgotten device stays forgotten after a restart
    Given the device setup looks for devices
    And the rider forgot the "heart-rate"
    When ridrs restarts
    And 60 seconds pass
    Then the heart-rate sensor "HRM-Pro 42" is not connected
    And the heart-rate sensor "Polar H10 A1B2" is not connected
    And the device status is:
      | kind       | state        | device |
      | heart-rate | disconnected |        |
    When the device setup looks for devices
    Then the heart-rate sensor "HRM-Pro 42" is connected

  Scenario: Unreadable settings are reported and ridrs connects the first device found
    Given the machine settings of "device-heart-rate" hold "{not json"
    When ridrs restarts
    Then the heart-rate sensor "HRM-Pro 42" is connected
    And the host reported a "settings-invalid" problem for plugin "device-heart-rate"
