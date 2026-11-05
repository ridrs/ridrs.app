@devices @fake-timers
Feature: Devices over this device's Bluetooth or the companion
  This device's Bluetooth (the direct link) and a paired companion phone both look for
  devices. A device that both see is listed once per link, each a device of its own. The first
  one seen directly connects; one only the companion sees waits two seconds for the direct link
  before it connects through the companion. A lost link reconnects over the same link; ridrs
  never switches links on its own. The rider switches by connecting the device found over the
  other link, which lets the first one go. Choices last for this run. A device first seen
  without its name takes the name once it arrives.

  Background:
    Given the host clock shows "10:00:00.000"
    And a companion "Pixel 8" that sees an FTMS trainer "KICKR CORE 1234"
    And the companion shows the pairing code "482913"
    And ridrs is paired with the companion

  Scenario: A device only the companion sees connects through the companion
    Given a simulated BLE environment without devices
    When the ridrs plugins "device-registry, transport-ble-bridge, device-ftms-trainer" run with the simulated BLE central and over the simulated network
    And 2 seconds pass
    Then the device status is:
      | kind    | state     | device          |
      | trainer | connected | KICKR CORE 1234 |
    And the "trainer" is connected through the "companion"

  Scenario: A device both links see is listed once per link and connects over this device's Bluetooth
    Given a simulated BLE environment with an FTMS trainer "KICKR CORE 1234"
    When the ridrs plugins "device-registry, transport-ble-bridge, device-ftms-trainer" run with the simulated BLE central and over the simulated network
    And the device setup looks for devices
    Then the "trainer" is connected through "this device"
    And the companion's trainer "KICKR CORE 1234" is not connected
    And the device status lists the "trainer" devices with their links:
      | device          | links       |
      | KICKR CORE 1234 | this device |
      | KICKR CORE 1234 | companion   |
    When the trainer sends the Indoor Bike Data packet "45 00 B4 00 C8 00"
    Then the published power measurement is "200 W"

  Scenario: A lost direct link reconnects over this device's Bluetooth, not the companion
    Given a simulated BLE environment with an FTMS trainer "KICKR CORE 1234"
    And the ridrs plugins "device-registry, transport-ble-bridge, device-ftms-trainer" run with the simulated BLE central and over the simulated network
    And the device setup looks for devices
    And the "trainer" is connected through "this device"
    When the trainer "KICKR CORE 1234" drops the connection and refuses new connections
    And 60 seconds pass
    Then the device status is:
      | kind    | state        | device          |
      | trainer | reconnecting | KICKR CORE 1234 |
    And the companion's trainer "KICKR CORE 1234" is not connected

  Scenario: The rider connects the device found through the companion instead
    Given a simulated BLE environment with an FTMS trainer "KICKR CORE 1234"
    And the ridrs plugins "device-registry, transport-ble-bridge, device-ftms-trainer" run with the simulated BLE central and over the simulated network
    And the device setup looks for devices
    And the "trainer" is connected through "this device"
    When the rider connects the "trainer" through the "companion"
    Then the "trainer" is connected through the "companion"
    And the trainer "KICKR CORE 1234" is not connected
    When the companion's trainer sends the Indoor Bike Data packet "45 00 B8 00 DC 00"
    Then the published power measurement is "220 W"

  Scenario: The rider connects the device over this device's Bluetooth again
    Given a simulated BLE environment with an FTMS trainer "KICKR CORE 1234"
    And the ridrs plugins "device-registry, transport-ble-bridge, device-ftms-trainer" run with the simulated BLE central and over the simulated network
    And the device setup looks for devices
    And the "trainer" is connected through "this device"
    And the rider connected the "trainer" through the "companion"
    When the rider connects the "trainer" through "this device"
    Then the "trainer" is connected through "this device"
    And the companion's trainer "KICKR CORE 1234" is not connected

  Scenario: The rider switches the link back and forth more than once
    Given a simulated BLE environment with an FTMS trainer "KICKR CORE 1234"
    And the ridrs plugins "device-registry, transport-ble-bridge, device-ftms-trainer" run with the simulated BLE central and over the simulated network
    And the device setup looks for devices
    And the "trainer" is connected through "this device"
    When the rider connects the "trainer" through the "companion"
    And the rider connects the "trainer" through "this device"
    And the rider connects the "trainer" through the "companion"
    Then the "trainer" is connected through the "companion"
    And the trainer "KICKR CORE 1234" is not connected
    When the rider connects the "trainer" through "this device"
    Then the "trainer" is connected through "this device"
    And the companion's trainer "KICKR CORE 1234" is not connected

  Scenario: A device first seen without its name takes its name once it arrives
    Given a simulated BLE environment with an FTMS trainer "KICKR CORE 1234" that advertises its name only later
    And the ridrs plugins "device-registry, transport-ble-bridge, device-ftms-trainer" run with the simulated BLE central and over the simulated network
    And the device setup looks for devices
    Then the device status lists the "trainer" devices with their links:
      | device          | links       |
      |                 | this device |
      | KICKR CORE 1234 | companion   |
    When the trainer "KICKR CORE 1234" advertises its name
    Then the device status lists the "trainer" devices with their links:
      | device          | links       |
      | KICKR CORE 1234 | this device |
      | KICKR CORE 1234 | companion   |
    And the "trainer" is connected through "this device"
