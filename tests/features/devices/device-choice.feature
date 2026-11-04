@devices @fake-timers
Feature: The rider chooses a device, disconnects it and connects it again
  With several devices of one kind in range, the first one found connects. While the device
  setup is open, ridrs keeps looking: every device of the kind is listed in the device status,
  devices switched on later too. The rider can connect another one instead. A device the
  rider disconnected stays disconnected until the rider connects it again. The choices last
  for this run.

  Background:
    Given a simulated BLE environment with a heart-rate sensor "HRM-Pro 42"
    And the simulated BLE environment also contains a heart-rate sensor "Polar H10 A1B2"
    And the ridrs plugins "device-registry, device-heart-rate" running with the simulated BLE central

  Scenario: The first device found connects
    Then the heart-rate sensor "HRM-Pro 42" is connected
    And the plugin "device-heart-rate" never connected to "Polar H10 A1B2"

  Scenario: While the setup looks for devices, every device of the kind is listed
    When the device setup looks for devices
    Then the device status lists the "heart-rate" devices "HRM-Pro 42, Polar H10 A1B2"
    And the heart-rate sensor "HRM-Pro 42" is connected

  Scenario: The rider connects another device of the same kind
    Given the device setup looks for devices
    When the rider connects the "heart-rate" "Polar H10 A1B2"
    Then the heart-rate sensor "Polar H10 A1B2" is connected
    And the heart-rate sensor "HRM-Pro 42" is not connected
    And the device status is:
      | kind       | state     | device         |
      | heart-rate | connected | Polar H10 A1B2 |

  Scenario: A disconnected device stays disconnected
    When the rider disconnects the "heart-rate"
    And 60 seconds pass
    Then the heart-rate sensor "HRM-Pro 42" is not connected
    And the plugin "device-heart-rate" never connected to "Polar H10 A1B2"
    And the device status is:
      | kind       | state        | device     |
      | heart-rate | disconnected | HRM-Pro 42 |

  Scenario: The rider connects a disconnected device again
    Given the rider disconnected the "heart-rate"
    When the rider connects the "heart-rate" "HRM-Pro 42"
    Then the heart-rate sensor "HRM-Pro 42" is connected
    And the device status is:
      | kind       | state     | device     |
      | heart-rate | connected | HRM-Pro 42 |

  Scenario: While the setup looks for devices, a device switched on later is listed too
    Given the simulated BLE environment also contains a switched-off heart-rate sensor "Garmin HRM 7"
    And the device setup looks for devices
    When the heart-rate sensor "Garmin HRM 7" is switched on
    Then the device status lists the "heart-rate" devices "HRM-Pro 42, Polar H10 A1B2, Garmin HRM 7"
    And the heart-rate sensor "HRM-Pro 42" is connected

  Scenario: Once connected and with the setup closed, ridrs stops looking for devices
    Given the device setup looks for devices
    When the device setup stops looking for devices
    Then the simulated BLE central has no active scan
