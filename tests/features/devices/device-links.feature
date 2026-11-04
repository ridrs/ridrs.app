@devices @fake-timers
Feature: Devices over this device's Bluetooth and the companion at once
  This device's Bluetooth (the direct link) and a paired companion phone both look for
  devices. A device that both see is one device: same kind, same name. It connects over every
  link that sees it, if it takes several connections, and ridrs uses the data of one link: the
  direct one, unless the rider chose the companion. Choosing a link only changes whose data is
  used; nothing connects or disconnects. If the link in use is lost, the data of the other one
  is used, and it stays the same device. A device only the companion sees waits two seconds
  for the direct link before it connects through the companion. Choices last for this run.

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

  Scenario: A device both links see connects over both, and the direct link's data is used
    Given a simulated BLE environment with an FTMS trainer "KICKR CORE 1234"
    When the ridrs plugins "device-registry, transport-ble-bridge, device-ftms-trainer" run with the simulated BLE central and over the simulated network
    Then the "trainer" is connected through "this device"
    And the "trainer" is connected over both links
    And the device status lists the "trainer" devices "KICKR CORE 1234"
    When the companion's trainer sends the Indoor Bike Data packet "45 00 B8 00 DC 00"
    Then the published power measurement is "none"
    When the trainer sends the Indoor Bike Data packet "45 00 B4 00 C8 00"
    Then the published power measurement is "200 W"

  Scenario: A lost direct link: the companion's data is used, and it is the same device
    Given a simulated BLE environment with an FTMS trainer "KICKR CORE 1234"
    And the ridrs plugins "device-registry, transport-ble-bridge, device-ftms-trainer" run with the simulated BLE central and over the simulated network
    And the "trainer" is connected over both links
    When the trainer "KICKR CORE 1234" drops the connection and refuses new connections
    Then the "trainer" is connected through the "companion"
    And the trainer keeps the device id it had over this device
    When the companion's trainer sends the Indoor Bike Data packet "45 00 B8 00 DC 00"
    Then the published power measurement is "220 W"

  Scenario: The rider uses the companion's data, and nothing connects or disconnects
    Given a simulated BLE environment with an FTMS trainer "KICKR CORE 1234"
    And the ridrs plugins "device-registry, transport-ble-bridge, device-ftms-trainer" run with the simulated BLE central and over the simulated network
    And the "trainer" is connected over both links
    When the rider uses the "trainer" data of the "companion"
    Then the "trainer" is connected through the "companion"
    And the "trainer" is connected over both links
    When the trainer sends the Indoor Bike Data packet "45 00 B4 00 C8 00"
    Then the published power measurement is "none"
    When the companion's trainer sends the Indoor Bike Data packet "45 00 B8 00 DC 00"
    Then the published power measurement is "220 W"

  Scenario: The rider uses this device's data again
    Given a simulated BLE environment with an FTMS trainer "KICKR CORE 1234"
    And the ridrs plugins "device-registry, transport-ble-bridge, device-ftms-trainer" run with the simulated BLE central and over the simulated network
    And the "trainer" is connected over both links
    And the rider used the "trainer" data of the "companion"
    When the rider uses the "trainer" data of "this device"
    Then the "trainer" is connected through "this device"
    And the "trainer" is connected over both links
