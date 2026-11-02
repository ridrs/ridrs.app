@phase-4 @fake-timers
Feature: Normalizing BLE Heart Rate Measurements
  The heart-rate plugin translates Heart Rate Measurement packets into standardized
  heart-rate measurement events. No other plugin ever sees protocol bytes.

  Background:
    Given a simulated BLE environment with a heart-rate sensor "HRM-Pro 42"
    And the ridrs plugins "device-heart-rate" running with the simulated BLE central
    And the heart-rate sensor "HRM-Pro 42" is connected

  Scenario Outline: Heart Rate Measurement packets become measurement events (<description>)
    When the heart-rate sensor sends the Heart Rate Measurement packet "<bytes>"
    Then the published heart-rate measurement is "<heartRate>"

    Examples:
      | description                         | bytes                      | heartRate |
      | 8-bit value                         | 00 48                      | 72 bpm    |
      | 16-bit value                        | 01 B4 00                   | 180 bpm   |
      | contact supported and detected      | 06 48                      | 72 bpm    |
      | energy expended is skipped          | 08 48 10 00                | 72 bpm    |
      | RR-intervals are skipped            | 10 48 00 04                | 72 bpm    |
      | all optional fields                 | 19 B4 00 10 00 00 04 00 04 | 180 bpm   |
      | contact supported but not detected  | 04 48                      | none      |
      | zero is no reading                  | 00 00                      | none      |

  Scenario Outline: Malformed packets produce no measurement (<description>)
    When the heart-rate sensor sends the Heart Rate Measurement packet "<bytes>"
    Then no measurement events were published
    And the host reported a "malformed-packet" problem for plugin "device-heart-rate"
    And the heart-rate sensor "HRM-Pro 42" is still connected

    Examples:
      | description              | bytes    |
      | truncated 16-bit value   | 01 48    |
      | truncated energy field   | 08 48 10 |
      | odd RR-interval bytes    | 10 48 00 |

  Scenario: Measurements carry an honest receive time
    Given the host clock shows "10:00:00.000"
    When the heart-rate sensor sends the Heart Rate Measurement packet "00 48"
    Then the heart-rate measurement was received at "10:00:00.000"
    And its measurement time is "10:00:00.000" with the timestamp origin "receive"
    And it names the heart-rate sensor "HRM-Pro 42" as its device

  Scenario: A lost sensor is reconnected
    When the heart-rate sensor "HRM-Pro 42" drops the connection and refuses new connections
    Then the connection state of "HRM-Pro 42" is "reconnecting"
    When the heart-rate sensor "HRM-Pro 42" accepts connections again
    And 2 seconds pass
    Then the connection state of "HRM-Pro 42" is "connected"

  Scenario: Trainer and heart-rate plugins do not take each other's devices
    Given the simulated BLE environment also contains an FTMS trainer "KICKR CORE 1234"
    And the ridrs plugin "device-ftms-trainer" is running with the simulated BLE central
    Then the plugin "device-heart-rate" never connected to "KICKR CORE 1234"
    And the plugin "device-ftms-trainer" never connected to "HRM-Pro 42"
