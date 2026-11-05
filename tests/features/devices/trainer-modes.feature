@phase-8 @fake-timers
Feature: The trainer device plugin chooses what to send
  By mode and by what the trainer can do. The physics computes both loads and decides
  nothing about the hardware: with a target power the trainer holds it (ERG), otherwise it
  simulates the road, with the virtual gear when there is a gear source.

  Background:
    Given a simulated BLE environment with an FTMS trainer "SIM KICKR" that supports simulation and target power
    And the ridrs physics plugins together with a probe plugin "test-ui"
    And the plugins "device-ftms-trainer, physics-trainer-load, control-virtual-gears, control-erg" are loaded as well
    And the simulated BLE central and a test controller "test-ride"

  Scenario: Free ride sends the gradient with the virtual gear
    Given a mock world "test-road" feeds the terrain ahead with a constant gradient of 5 % when the ride starts
    And the host has started
    When "test-ui" publishes "activity.start-requested"
    And 2 s pass
    Then the latest "trainer.command" is a simulation with the gradient of the trainer load with virtual gear
    And the trainer received "07" before the first simulation command
    And the latest "trainer.control-changed" event has the mode "simulation"

  # Without gears the plain load: grade 0, Crr 0.004 · 2 on gravel = 80 (0x50), cw 0.392 = 39 (0x27).
  Scenario: A simulation command is the encoded trainer load
    Given the plugin "control-virtual-gears" is not installed
    And a mock world "test-road" feeds flat "gravel" ahead when the ride starts
    And the host has started
    When "test-ui" publishes "activity.start-requested"
    And 2 s pass
    Then the trainer received the write "11 00 00 00 00 50 27" with response on "2ad9"

  Scenario: Simulation commands are rate-limited
    Given a mock world "test-road" feeds a gradient that alternates between 0 % and 5 % every metre when the ride starts
    And the host has started
    And "test-ui" published "activity.start-requested"
    When the trainer "SIM KICKR" sends 200 W every 0.25 s for 10 seconds
    Then the trainer received at most 11 simulation commands
    And the simulation commands were at least 1000 ms apart

  Scenario: An unchanged load is not sent again
    Given a mock world "test-road" feeds the terrain ahead with a constant gradient of 5 % when the ride starts
    And the host has started
    And "test-ui" published "activity.start-requested"
    And 2 s pass
    When 10 s pass
    Then the trainer received no simulation command in the last 10 s

  Scenario: A shift is sent at once
    Given a mock world "test-road" feeds the terrain ahead with a constant gradient of 5 % when the ride starts
    And the host has started
    And "test-ui" published "activity.start-requested"
    And 2 s pass
    When "test-ride" presses "shift-up-right" once
    Then the trainer received a simulation command in the last 0.2 s
    And the latest "trainer.command" is a simulation with the gradient of the trainer load with virtual gear

  Scenario: Without a gear source the plain load is sent
    Given the plugin "control-virtual-gears" is not installed
    And a mock world "test-road" feeds the terrain ahead with a constant gradient of 5 % when the ride starts
    And the host has started
    When "test-ui" publishes "activity.start-requested"
    And 2 s pass
    Then the latest "trainer.command" is a simulation with the gradient 0.05

  Scenario: ERG holds the target power
    Given a mock world "test-road" feeds the terrain ahead with a constant gradient of 5 % when the ride starts
    And the host has started
    And "test-ui" published "activity.start-requested"
    When "test-ui" sets the target power to 180 W
    Then the trainer received the write "05 b4 00" with response on "2ad9"
    And the latest "trainer.control-changed" event has the mode "erg"
    When the trainer "SIM KICKR" sends 200 W every 0.25 s for 10 seconds
    Then the rider power at "+10 s" is 200.00 W

  Scenario: The target is clamped to the trainer's power range
    Given the trainer "SIM KICKR" supports target power from 50 W to 1000 W
    And a mock world "test-road" feeds the terrain ahead with a constant gradient of 5 % when the ride starts
    And the host has started
    And "test-ui" published "activity.start-requested"
    When "test-ui" sets the target power to 1500 W
    Then the latest "trainer.command" is a target power of 1000 W

  Scenario: The virtual gear does not touch the trainer in ERG
    Given a mock world "test-road" feeds the terrain ahead with a constant gradient of 5 % when the ride starts
    And the host has started
    And "test-ui" published "activity.start-requested"
    And "test-ui" set the target power to 180 W
    When "test-ride" presses "shift-up-right" twice
    And 3 s pass
    Then the trainer received no simulation command after the target power

  Scenario: Leaving ERG goes back to simulation
    Given a mock world "test-road" feeds the terrain ahead with a constant gradient of 5 % when the ride starts
    And the host has started
    And "test-ui" published "activity.start-requested"
    And "test-ui" set the target power to 180 W
    When "test-ui" leaves ERG
    And 0.5 s pass
    Then the latest "trainer.command" is a simulation
    And the latest "trainer.control-changed" event has the mode "simulation"

  Scenario: A trainer without target power stays in simulation
    Given the trainer "SIM KICKR" supports simulation only
    And a mock world "test-road" feeds the terrain ahead with a constant gradient of 5 % when the ride starts
    And the host has started
    And "test-ui" published "activity.start-requested"
    When "test-ui" sets the target power to 180 W
    And 2 s pass
    Then the latest "trainer.control-changed" event has the mode "simulation"
    And the trainer received no target power command

  Scenario: Control comes back after a reconnect with the last command
    Given a mock world "test-road" feeds the terrain ahead with a constant gradient of 5 % when the ride starts
    And the host has started
    And "test-ui" published "activity.start-requested"
    And 2 s pass
    When the trainer "SIM KICKR" drops the connection and refuses new connections
    And the trainer "SIM KICKR" accepts connections again
    And 2 s pass
    Then a "trainer-control-lost" diagnostic was reported once
    And the trainer received "00" again
    And the trainer received the last simulation command again

  Scenario: A failed command is reported, at most once in 10 s
    Given the trainer "SIM KICKR" answers "Set Indoor Bike Simulation Parameters" with "Operation Failed"
    And a mock world "test-road" feeds a gradient that alternates between 0 % and 5 % every metre when the ride starts
    And the host has started
    And "test-ui" published "activity.start-requested"
    When the trainer "SIM KICKR" sends 200 W every 0.25 s for 9 seconds
    Then a "trainer-command-failed" diagnostic was reported once

  Scenario: Finishing a ride releases the trainer
    Given a mock world "test-road" feeds the terrain ahead with a constant gradient of 5 % when the ride starts
    And the host has started
    And "test-ui" published "activity.start-requested"
    And "test-ui" set the target power to 180 W
    When "test-ui" publishes "activity.finish-requested"
    And 5 s pass
    Then the trainer's last command leaves it neutral
    And the latest "trainer.control-changed" event has the mode "simulation"
