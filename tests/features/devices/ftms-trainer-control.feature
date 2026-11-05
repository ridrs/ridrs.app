@phase-8 @fake-timers
Feature: The trainer's control point
  ridrs takes control of an FTMS trainer when it offers a control point, and leaves it a
  plain sensor when it does not. It reads what the trainer can do from the Fitness Machine
  Feature characteristic, writes every control-point command with response, and hears the
  trainer's answer as an indication "80 <op code> <result>" (FTMS 1.0, 4.16.2.22).

  Background:
    Given a simulated BLE environment with an FTMS trainer "SIM KICKR" that supports simulation and target power
    And the ridrs plugins "device-ftms-trainer, metric-power, metric-cadence, activity-session" with the simulated BLE central and a probe plugin "test-ui"

  Scenario: Control is requested on connection
    When the host has started
    Then the trainer "SIM KICKR" is connected
    And the trainer received the write "00" with response on "2ad9"
    And the latest "trainer.control-changed" event has the control "granted" and the features simulation and target power

  Scenario: A trainer without a control point stays a sensor
    Given the trainer "SIM KICKR" offers no control point
    When the host has started
    Then the trainer "SIM KICKR" is connected
    And the latest "trainer.control-changed" event has the control "unsupported" and the mode "none"
    And the trainer received no writes
    When the trainer sends the Indoor Bike Data packet "45 00 B4 00 C8 00"
    Then the published power measurement is "200 W"

  Scenario: A trainer that sets no target stays a sensor
    Given the trainer "SIM KICKR" supports neither simulation nor target power
    When the host has started
    Then the latest "trainer.control-changed" event has the control "unsupported" and the mode "none"
    And the trainer received no writes

  Scenario: A refused request is shown, the ride goes on
    Given the trainer "SIM KICKR" refuses "Request Control"
    When the host has started
    Then the latest "trainer.control-changed" event has the control "refused"
    And a "trainer-command-failed" diagnostic was reported once
    When the trainer sends the Indoor Bike Data packet "45 00 B4 00 C8 00"
    Then the published power measurement is "200 W"

  Scenario: The ride start starts the trainer
    Given the host has started
    When "test-ui" publishes "activity.start-requested"
    Then the trainer received the writes "00, 07" with response on "2ad9"

  Scenario: Every write is recorded before it is sent
    When the host has started
    Then the latest "device.raw-write" event has the data "00", the characteristic "2ad9" and with response
    And its source is "device-ftms-trainer"
    And it was published before the trainer received the write

  Scenario: A lost trainer loses control, and gets it back on reconnect
    Given the host has started
    And "test-ui" published "activity.start-requested"
    When the trainer "SIM KICKR" drops the connection and refuses new connections
    Then the latest "trainer.control-changed" event has the control "lost"
    And a "trainer-control-lost" diagnostic was reported once
    When the trainer "SIM KICKR" accepts connections again
    And 2 seconds pass
    Then the latest "trainer.control-changed" event has the control "granted"
    And the trainer received the writes "00, 07, 00, 07" with response on "2ad9"
    And a "trainer-control-lost" diagnostic was reported once
