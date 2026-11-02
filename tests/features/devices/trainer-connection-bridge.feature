@phase-3b @fake-timers
Feature: The FTMS trainer over the BLE bridge
  The unchanged device plugin works on top of transport-ble-bridge: a companion phone in the
  same network holds the Bluetooth link, ridrs only sees a remote BLE central.

  Background:
    Given the host clock shows "10:00:00.000"
    And a companion "Pixel 8" wrapping a simulated BLE environment with an FTMS trainer "KICKR CORE 1234"
    And the companion shows the pairing code "482913"
    And ridrs is paired with the companion
    And the ridrs plugins "transport-ble-bridge, device-ftms-trainer, metric-power, metric-cadence" running over the simulated network

  Scenario: Power arrives through the bridge
    Given the trainer "KICKR CORE 1234" is connected
    When the trainer sends the Indoor Bike Data packet "45 00 B4 00 C8 00"
    Then the latest "metric.power" is 200 W from the trainer "KICKR CORE 1234" measured at "10:00:00.000"

  Scenario: Receive time is the ridrs clock, not the companion's
    Given the trainer "KICKR CORE 1234" is connected
    And the companion clock runs 3 seconds ahead
    When the trainer sends the Indoor Bike Data packet "45 00 B4 00 C8 00"
    Then the power measurement was received at "10:00:00.000"

  Scenario: A lost network reconnects the trainer by its id
    Given the trainer "KICKR CORE 1234" is connected
    When the companion leaves the network
    Then the connection state of "KICKR CORE 1234" is "reconnecting"
    And the bridge state is "reconnecting"
    When the companion joins the network again
    And 2 seconds pass
    Then the bridge state is "connected"
    And the connection state of "KICKR CORE 1234" is "connected"
    And the companion received 1 scan request

  Scenario: A Wi-Fi stall shorter than the heartbeat timeout is not a connection loss
    Given the trainer "KICKR CORE 1234" is connected
    When the network delivers nothing for 4 seconds
    Then the connection state of "KICKR CORE 1234" is "connected"

  Scenario: Silence longer than the heartbeat timeout is a connection loss
    Given the trainer "KICKR CORE 1234" is connected
    When the network delivers nothing for 5 seconds
    Then the connection state of "KICKR CORE 1234" is "reconnecting"

  Scenario: An unreachable companion is reported, not fatal
    Given the trainer "KICKR CORE 1234" is connected
    When the companion leaves the network
    And 2 seconds pass
    Then the host reported a "bridge-unreachable" problem for plugin "transport-ble-bridge"
    And the bridge state is "reconnecting"

  Scenario: Stopping the transport user releases the trainer on the companion
    Given the trainer "KICKR CORE 1234" is connected
    When the plugin "device-ftms-trainer" is stopped
    Then the companion holds no subscriptions
    And the trainer "KICKR CORE 1234" is no longer connected
