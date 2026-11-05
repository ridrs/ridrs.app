@phase-8 @fake-timers
Feature: Trainer commands are recorded and replayed
  Commands are derived from recorded inputs: the connection, the read Feature, the
  trainer's answers, the buttons and the target power. A replay reproduces them exactly,
  without a trainer.

  Scenario: A ride with shifting and ERG replays identically
    Given a recorded ride with the simulated trainer, a climb, 3 shifts and 20 s of ERG at 180 W
    When the recording is replayed
    Then the replay is identical
    And the replay compared all of the "trainer.command", "trainer.control-changed", "drivetrain.gear-changed" and "device.raw-write" events of the ride
