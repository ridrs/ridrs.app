@devices @fake-timers
Feature: One status per kind of device
  Device plugins say which kind of device they connect. The device registry turns the
  connection states of all device plugins into one status per kind, so a screen that opens
  later still knows every device, not only the one that changed last.

  Scenario: Device plugins say which kind of device they connect
    Given a simulated BLE environment with a heart-rate sensor "HRM-Pro 42"
    And the simulated BLE environment also contains an FTMS trainer "KICKR CORE 1234"
    And the ridrs plugins "device-ftms-trainer, device-heart-rate" with the simulated BLE central
    When the host starts
    Then every connection state of "device-ftms-trainer" is for a "trainer"
    And every connection state of "device-heart-rate" is for a "heart-rate"

  Scenario: Without device plugins the status lists no device
    Given the ridrs plugins "device-registry" running
    Then the device status lists no device

  Scenario: Every kind shows its own connection
    Given a simulated BLE environment with a heart-rate sensor "HRM-Pro 42"
    And the simulated BLE environment also contains an FTMS trainer "KICKR CORE 1234"
    And the ridrs plugins "device-registry, device-ftms-trainer, device-heart-rate" running with the simulated BLE central
    Then the device status is:
      | kind       | state     | device          |
      | trainer    | connected | KICKR CORE 1234 |
      | heart-rate | connected | HRM-Pro 42      |

  Scenario: A kind without a device keeps searching
    Given a simulated BLE environment with an FTMS trainer "KICKR CORE 1234"
    And the ridrs plugins "device-registry, device-ftms-trainer, device-heart-rate" running with the simulated BLE central
    Then the device status is:
      | kind       | state     | device          |
      | trainer    | connected | KICKR CORE 1234 |
      | heart-rate | searching |                 |

  Scenario: A lost connection shows as reconnecting, and the device keeps its name
    Given a simulated BLE environment with an FTMS trainer "KICKR CORE 1234"
    And the ridrs plugins "device-registry, device-ftms-trainer" running with the simulated BLE central
    When the trainer "KICKR CORE 1234" drops the connection and refuses new connections
    Then the device status is:
      | kind    | state        | device          |
      | trainer | reconnecting | KICKR CORE 1234 |

  Scenario: Connection states without a kind are left out
    Given the ridrs plugins "device-registry" together with a test device plugin "test-device"
    And the host has started
    When "test-device" reports device "trainer-1" as "connected"
    Then the device status lists no device
