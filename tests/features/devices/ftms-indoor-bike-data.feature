@phase-2 @fake-timers
Feature: Normalizing FTMS Indoor Bike Data
  The FTMS trainer plugin translates Bluetooth FTMS packets into standardized
  power and cadence measurement events. No other plugin ever sees protocol bytes.

  Background:
    Given a simulated BLE environment with an FTMS trainer "KICKR CORE 1234"
    And the ridrs plugins "device-ftms-trainer" running with the simulated BLE central
    And the trainer "KICKR CORE 1234" is connected

  Scenario Outline: Indoor Bike Data packets become measurement events (<description>)
    When the trainer sends the Indoor Bike Data packet "<bytes>"
    Then the published power measurement is "<power>"
    And the published cadence measurement is "<cadence>"

    Examples:
      | description                          | bytes                               | power | cadence  |
      | speed, cadence and power             | 44 00 B8 0B B4 00 C8 00             | 200 W | 90 rpm   |
      | no speed field when More Data is set | 45 00 B4 00 C8 00                   | 200 W | 90 rpm   |
      | preceding 16-bit fields are skipped  | 66 00 B8 0B A0 0F B4 00 0A 00 FA 00 | 250 W | 90 rpm   |
      | preceding 24-bit distance is skipped | 55 00 B4 00 10 27 00 C8 00          | 200 W | 90 rpm   |
      | average cadence is not instantaneous | 4D 00 B4 00 AA 00 C8 00             | 200 W | 90 rpm   |
      | half-rpm cadence resolution          | 45 00 B5 00 C8 00                   | 200 W | 90.5 rpm |
      | zero is a real measurement           | 45 00 00 00 00 00                   | 0 W   | 0 rpm    |
      | cadence without power                | 05 00 B4 00                         | none  | 90 rpm   |
      | power without cadence                | 41 00 C8 00                         | 200 W | none     |

  Scenario: Measurements carry receive time and an honest measurement time
    Given the host clock shows "10:00:00.000"
    When the trainer sends the Indoor Bike Data packet "45 00 B4 00 C8 00"
    Then the power measurement was received at "10:00:00.000"
    And its measurement time is "10:00:00.000" with the timestamp origin "receive"
    And it names the trainer "KICKR CORE 1234" as its device

  Scenario: Every packet is published with its own receive time
    Given the host clock shows "10:00:00.000"
    When the trainer sends the Indoor Bike Data packet "45 00 B4 00 C8 00"
    And 0.25 seconds pass
    And the trainer sends the Indoor Bike Data packet "45 00 B6 00 D2 00"
    And 1 second passes
    And the trainer sends the Indoor Bike Data packet "45 00 B8 00 DC 00"
    Then the power measurements were:
      | value | receivedAt   |
      | 200   | 10:00:00.000 |
      | 210   | 10:00:00.250 |
      | 220   | 10:00:01.250 |
    And the cadence measurements were:
      | value | receivedAt   |
      | 90    | 10:00:00.000 |
      | 91    | 10:00:00.250 |
      | 92    | 10:00:01.250 |

  Scenario: A truncated packet produces no measurements
    When the trainer sends the Indoor Bike Data packet "45 00 B4"
    Then no measurement events were published
    And the host reported a "malformed-packet" problem for plugin "device-ftms-trainer"
    And the trainer "KICKR CORE 1234" is still connected
