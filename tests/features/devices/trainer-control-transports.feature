@phase-8 @devices @fake-timers
Feature: Trainer control over every BLE transport
  Controlling an FTMS trainer needs more of a BLE connection than listening: reading the
  Feature characteristic, writing with response and hearing indications. The unchanged trainer
  plugin takes control over the Tauri transport and over the companion bridge (protocol 1.3)
  alike.

  Scenario: Control over the Tauri transport
    Given a simulated Tauri bridge with an FTMS trainer "SIM KICKR" that supports simulation and target power
    And the ridrs plugins "transport-ble-tauri, device-ftms-trainer" running
    And the trainer "SIM KICKR" is connected
    Then the trainer received the write "00" with response on "2ad9"
    And the latest "trainer.control-changed" event has the control "granted" and the features simulation and target power

  Scenario: Control over the companion bridge
    Given the host clock shows "10:00:00.000"
    And a companion "Pixel 8" wrapping a simulated BLE environment with an FTMS trainer "SIM KICKR" that supports simulation and target power
    And the companion shows the pairing code "482913"
    And ridrs is paired with the companion
    And the ridrs plugins "transport-ble-bridge, device-ftms-trainer" running over the simulated network
    And the trainer "SIM KICKR" is connected
    Then the trainer received the write "00" with response on "2ad9"
    And the latest "trainer.control-changed" event has the control "granted" and the features simulation and target power
