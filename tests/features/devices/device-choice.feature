@devices @fake-timers
Feature: The rider chooses a device, forgets it and connects it again
  With several devices of one kind in range, the first one found connects. While the device
  setup is open, ridrs keeps looking: every device of the kind is listed in the device status,
  devices switched on later too; a device not heard for 15 seconds leaves the list. The rider can connect another one instead. When the rider forgets the device of a kind, it is
  let go and no device of the kind connects on its own any more, not while the setup stays open
  and not once it closes. The rider can connect one; the next time the setup opens, the best
  device found connects on its own again: one seen directly before one seen through the
  companion, then the one with the strongest signal. The choices last for this run.

  Background:
    Given a simulated BLE environment with a heart-rate sensor "HRM-Pro 42"
    And the simulated BLE environment also contains a heart-rate sensor "Polar H10 A1B2"
    And the ridrs plugins "device-heart-rate" running with the simulated BLE central

  Scenario: The first device found connects
    Then the heart-rate sensor "HRM-Pro 42" is connected
    And the plugin "device-heart-rate" never connected to "Polar H10 A1B2"

  Scenario: While the setup looks for devices, every device of the kind is listed
    When the device setup looks for devices
    Then the device status lists the "heart-rate" devices "HRM-Pro 42, Polar H10 A1B2"
    And the heart-rate sensor "HRM-Pro 42" is connected

  Scenario: A device that stops advertising leaves the list after 15 seconds
    Given the device setup looks for devices
    And the rider forgot the "heart-rate"
    And the heart-rate sensor "Polar H10 A1B2" is switched off
    When 14 seconds pass
    Then the device status lists the "heart-rate" devices "HRM-Pro 42, Polar H10 A1B2"
    When 2 seconds pass
    Then the device status lists the "heart-rate" devices "HRM-Pro 42"

  Scenario: Every device found carries its signal strength
    Given the device setup looks for devices
    When the heart-rate sensor "Polar H10 A1B2" has a signal of -48 dBm
    And the heart-rate sensor "HRM-Pro 42" has a signal of -71 dBm
    Then the device status gives the "heart-rate" devices the signals:
      | device         | signal |
      | HRM-Pro 42     | -71    |
      | Polar H10 A1B2 | -48    |

  Scenario: Every device found carries its signal strength
    Given the device setup looks for devices
    When the heart-rate sensor "Polar H10 A1B2" has a signal of -48 dBm
    And the heart-rate sensor "HRM-Pro 42" has a signal of -71 dBm
    Then the device status gives the "heart-rate" devices the signals:
      | device         | signal |
      | HRM-Pro 42     | -71    |
      | Polar H10 A1B2 | -48    |

  Scenario: The rider connects another device of the same kind
    Given the device setup looks for devices
    When the rider connects the "heart-rate" "Polar H10 A1B2"
    Then the heart-rate sensor "Polar H10 A1B2" is connected
    And the heart-rate sensor "HRM-Pro 42" is not connected
    And the device status is:
      | kind       | state     | device         |
      | heart-rate | connected | Polar H10 A1B2 |

  Scenario: After the rider forgets the device, no device of the kind connects on its own
    Given the device setup looks for devices
    When the rider forgets the "heart-rate"
    And 60 seconds pass
    Then the heart-rate sensor "HRM-Pro 42" is not connected
    And the heart-rate sensor "Polar H10 A1B2" is not connected
    And the device status is:
      | kind       | state     | device |
      | heart-rate | searching |        |
    And the device status lists the "heart-rate" devices "HRM-Pro 42, Polar H10 A1B2"

  Scenario: After the rider forgets the device, a device switched on later does not connect either
    Given the simulated BLE environment also contains a switched-off heart-rate sensor "Garmin HRM 7"
    And the device setup looks for devices
    And the rider forgot the "heart-rate"
    When the heart-rate sensor "Garmin HRM 7" is switched on
    And 60 seconds pass
    Then the device status lists the "heart-rate" devices "HRM-Pro 42, Polar H10 A1B2, Garmin HRM 7"
    And the heart-rate sensor "Garmin HRM 7" is not connected
    And the heart-rate sensor "HRM-Pro 42" is not connected
    And the heart-rate sensor "Polar H10 A1B2" is not connected

  Scenario: Once the setup closes, no device of the forgotten kind connects on its own
    Given the device setup looks for devices
    And the rider forgot the "heart-rate"
    When the device setup stops looking for devices
    And 60 seconds pass
    Then the heart-rate sensor "HRM-Pro 42" is not connected
    And the heart-rate sensor "Polar H10 A1B2" is not connected
    And the device status is:
      | kind       | state        | device |
      | heart-rate | disconnected |        |
    And the simulated BLE central has no active scan

  Scenario: When the setup opens again, the device with the strongest signal connects
    Given the device setup looks for devices
    And the heart-rate sensor "Polar H10 A1B2" has a signal of -48 dBm
    And the heart-rate sensor "HRM-Pro 42" has a signal of -71 dBm
    And the rider forgot the "heart-rate"
    And the device setup stopped looking for devices
    And the heart-rate sensor "Polar H10 A1B2" is not connected
    When the device setup looks for devices
    Then the heart-rate sensor "Polar H10 A1B2" is connected
    And the heart-rate sensor "HRM-Pro 42" is not connected
    And the device status is:
      | kind       | state     | device         |
      | heart-rate | connected | Polar H10 A1B2 |

  Scenario: The rider connects a forgotten device again
    Given the device setup looks for devices
    And the rider forgot the "heart-rate"
    When the rider connects the "heart-rate" "HRM-Pro 42"
    Then the heart-rate sensor "HRM-Pro 42" is connected
    And the heart-rate sensor "Polar H10 A1B2" is not connected
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

  Scenario: The device status says over which links ridrs looks for devices of the kind
    Given the device setup looks for devices
    Then the device status says ridrs looks for "heart-rate" devices over "this device"
    When the device setup stops looking for devices
    Then the device status says ridrs looks for "heart-rate" devices over no link

  Scenario: A search that failed is no longer named in the device status
    Given the device setup looks for devices
    When the simulated BLE central's searches fail
    Then the device status says ridrs looks for "heart-rate" devices over no link
