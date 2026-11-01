@phase-2 @fake-timers
Feature: Trainer connection lifecycle
  The FTMS trainer plugin finds a trainer, connects, detects connection loss
  and reconnects with backoff - and stops all of this cleanly when stopped.

  Background:
    Given a simulated BLE environment with an FTMS trainer "KICKR CORE 1234"
    And the ridrs plugins "device-ftms-trainer" with the simulated BLE central

  Scenario: The plugin finds and connects to an FTMS trainer
    When the host starts
    Then the connection states of "KICKR CORE 1234" were "searching, connecting, connected"
    And the plugin is subscribed to Indoor Bike Data of "KICKR CORE 1234"

  Scenario: Peripherals without FTMS are ignored
    Given the simulated BLE environment also contains a peripheral "HRM-Pro" without FTMS
    When the host starts
    Then the plugin connected to "KICKR CORE 1234"
    And the plugin never connected to "HRM-Pro"

  Scenario: Waiting for a trainer that is switched on later
    Given the trainer "KICKR CORE 1234" is switched off
    When the host starts
    And 10 seconds pass
    Then the connection states of "KICKR CORE 1234" were "searching"
    When the trainer "KICKR CORE 1234" is switched on
    And 1 second passes
    Then the connection state of "KICKR CORE 1234" is "connected"

  Scenario: A lost connection is detected and re-established
    Given the host has started
    And the trainer "KICKR CORE 1234" is connected
    When the trainer "KICKR CORE 1234" drops the connection and refuses new connections
    Then the connection state of "KICKR CORE 1234" is "reconnecting"
    When the trainer "KICKR CORE 1234" accepts connections again
    And 2 seconds pass
    Then the connection state of "KICKR CORE 1234" is "connected"
    And the plugin is subscribed to Indoor Bike Data of "KICKR CORE 1234"
    When the trainer sends the Indoor Bike Data packet "45 00 B4 00 C8 00"
    Then the published power measurement is "200 W"

  Scenario: Reconnection attempts back off while the trainer stays away
    Given the host has started
    And the trainer "KICKR CORE 1234" is connected
    When the trainer "KICKR CORE 1234" drops the connection and refuses new connections
    And 120 seconds pass
    Then the reconnection attempts were made after waiting "1, 2, 4, 8, 16, 30, 30" seconds

  Scenario: Stopping the plugin disconnects and ends reconnection
    Given the host has started
    And the trainer "KICKR CORE 1234" is connected
    When the trainer "KICKR CORE 1234" drops the connection and refuses new connections
    And the plugin "device-ftms-trainer" is stopped
    And 60 seconds pass
    Then the last connection state of "KICKR CORE 1234" is "disconnected"
    And no reconnection attempt was made after the plugin stopped

  Scenario: Stopping the plugin while searching ends the scan
    Given the trainer "KICKR CORE 1234" is switched off
    And the host has started
    When the plugin "device-ftms-trainer" is stopped
    Then the simulated BLE central has no active scan
    And the plugin's abort signal is aborted
