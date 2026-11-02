@phase-3b @fake-timers
Feature: Dummy devices in the developer companion
  The developer build of the companion offers simulated trainers next to the real Bluetooth
  devices, so ridrs can be tested by hand without hardware. ridrs cannot tell them apart.

  Background:
    Given the host clock shows "10:00:00.000"
    And a developer companion "Pixel 8" without real Bluetooth devices
    And the companion shows the pairing code "482913"
    And ridrs is paired with the companion
    And the ridrs plugins "transport-ble-bridge, device-ftms-trainer, metric-power, metric-cadence" running over the simulated network

  Scenario: A steady dummy trainer
    When the developer adds a dummy FTMS trainer with the profile "steady"
    And 2 seconds pass
    Then the latest "metric.power" is 220 W from the trainer "KICKR SIM (dummy)"

  Scenario: A ramp dummy trainer climbs
    When the developer adds a dummy FTMS trainer with the profile "ramp"
    And 31 seconds pass
    Then the latest "metric.power" is 200 W from the trainer "KICKR SIM (dummy)"

  Scenario: A dummy dropout is seen as a real connection loss
    Given the developer added a dummy FTMS trainer with the profile "dropout"
    When 21 seconds pass
    Then the connection state of "KICKR SIM (dummy)" is "reconnecting"
    When 6 seconds pass
    Then the connection state of "KICKR SIM (dummy)" is "connected"

  Scenario: Malformed dummy packets are reported by the device plugin
    When the developer adds a dummy FTMS trainer with the profile "malformed"
    And 3 seconds pass
    Then the host reported a "malformed-packet" problem for plugin "device-ftms-trainer"

  Scenario: Removing a dummy trainer is a connection loss
    Given the developer added a dummy FTMS trainer with the profile "steady"
    And 2 seconds pass
    When the developer removes the dummy trainer "KICKR SIM (dummy)"
    Then the connection state of "KICKR SIM (dummy)" is "reconnecting"
