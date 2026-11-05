@devices @fake-timers
Feature: The same device over both links
  A device both links see is listed once per link, each a device of its own; the device setup
  shows the two as one device. Two devices found are the same device when they were found over
  different links, have the same name, and no part of their advertising data that both report
  differs (manufacturer data by company, service data by service). A part whose bytes change
  decides nothing. Without advertising data both report, the name decides, but only when there
  is one device of the name on each link. Which device connects stays as it was.

  Background:
    Given the host clock shows "10:00:00.000"

  Scenario: Same name and the same manufacturer data are the same device
    Given a simulated BLE environment with the FTMS trainers:
      | device          | manufacturer data |
      | KICKR CORE 1234 | 0157 a1b2c3d4     |
    And a companion "Pixel 8" that sees the FTMS trainers:
      | device          | manufacturer data |
      | KICKR CORE 1234 | 0157 a1b2c3d4     |
    When ridrs runs paired with the companion and the device setup looks for devices
    Then the device status pairs the "trainer" devices:
      | device          | link        | same device over |
      | KICKR CORE 1234 | this device | companion        |
      | KICKR CORE 1234 | companion   | this device      |
    And the "trainer" is connected through "this device"

  Scenario: Devices of one name are told apart by their manufacturer data
    Given a simulated BLE environment with the FTMS trainers:
      | device      | manufacturer data |
      | Wahoo KICKR | 0157 0001         |
      | Wahoo KICKR | 0157 0002         |
    And a companion "Pixel 8" that sees the FTMS trainers:
      | device      | manufacturer data |
      | Wahoo KICKR | 0157 0002         |
    When ridrs runs paired with the companion and the device setup looks for devices
    Then the device status pairs the "trainer" devices:
      | device      | link        | same device over |
      | Wahoo KICKR | this device |                  |
      | Wahoo KICKR | this device | companion        |
      | Wahoo KICKR | companion   | this device      |

  Scenario: Different service data are different devices
    Given a simulated BLE environment with the FTMS trainers:
      | device      | service data |
      | Wahoo KICKR | fe95 0102    |
    And a companion "Pixel 8" that sees the FTMS trainers:
      | device      | service data |
      | Wahoo KICKR | fe95 0103    |
    When ridrs runs paired with the companion and the device setup looks for devices
    Then the device status pairs the "trainer" devices:
      | device      | link        | same device over |
      | Wahoo KICKR | this device |                  |
      | Wahoo KICKR | companion   |                  |

  Scenario: Without advertising data, one device of the name on each link is the same device
    Given a simulated BLE environment with the FTMS trainers:
      | device          |
      | KICKR CORE 1234 |
    And a companion "Pixel 8" that sees the FTMS trainers:
      | device          | manufacturer data |
      | KICKR CORE 1234 | 0157 a1b2c3d4     |
    When ridrs runs paired with the companion and the device setup looks for devices
    Then the device status pairs the "trainer" devices:
      | device          | link        | same device over |
      | KICKR CORE 1234 | this device | companion        |
      | KICKR CORE 1234 | companion   | this device      |

  Scenario: Without advertising data, two devices of the name on one link pair with none
    Given a simulated BLE environment with the FTMS trainers:
      | device    |
      | Wahoo HRM |
      | Wahoo HRM |
    And a companion "Pixel 8" that sees the FTMS trainers:
      | device    |
      | Wahoo HRM |
    When ridrs runs paired with the companion and the device setup looks for devices
    Then the device status pairs the "trainer" devices:
      | device    | link        | same device over |
      | Wahoo HRM | this device |                  |
      | Wahoo HRM | this device |                  |
      | Wahoo HRM | companion   |                  |

  Scenario: Manufacturer data whose bytes change decides nothing
    Given a simulated BLE environment with the FTMS trainers:
      | device          | manufacturer data |
      | KICKR CORE 1234 | 0157 aa01         |
    And a companion "Pixel 8" that sees the FTMS trainers:
      | device          | manufacturer data |
      | KICKR CORE 1234 | 0157 aa02         |
    When ridrs runs paired with the companion and the device setup looks for devices
    Then the device status pairs the "trainer" devices:
      | device          | link        | same device over |
      | KICKR CORE 1234 | this device |                  |
      | KICKR CORE 1234 | companion   |                  |
    When the companion's trainer "KICKR CORE 1234" advertises the manufacturer data "0157 aa03"
    Then the device status pairs the "trainer" devices:
      | device          | link        | same device over |
      | KICKR CORE 1234 | this device | companion        |
      | KICKR CORE 1234 | companion   | this device      |
