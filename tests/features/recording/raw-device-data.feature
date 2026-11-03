@phase-9 @fake-timers
Feature: Raw device data is recorded before it is decoded
  The bytes a device sends are the root of every derived value. They are recorded
  unchanged - including packets the decoder rejects.

  Background:
    Given a simulated BLE environment with an FTMS trainer "SIM KICKR"
    And the ridrs plugins "device-ftms-trainer, metric-power, metric-cadence, activity-session, recording-session" together with a probe plugin "test-ui" and the memory storage
    And the host has started
    And "test-ui" published "activity.start-requested" through the UI bridge

  Scenario: Every notification becomes a raw event
    When the trainer notifies "44 00 00 00 b4 00 c8 00"
    Then the latest "device.raw-notification" event has the data "44000000b400c800", the service "1826" and the characteristic "2ad2"
    And its source is "device-ftms-trainer"
    And it was published before the "measurement.power" event of the same packet

  Scenario: A malformed packet is recorded although it is not decoded
    When the trainer notifies "44"
    Then the latest "device.raw-notification" event has the data "44"
    And a "malformed-packet" diagnostic was reported
    And no "measurement.power" event was published for it

  Scenario: Raw data and diagnostics end up in the recording
    Given the trainer notified "44 00 00 00 b4 00 c8 00"
    And the trainer notified "44"
    When "test-ui" publishes "activity.finish-requested" through the UI bridge
    Then the recording contains 2 "device.raw-notification" events with the data "44000000b400c800" and "44"
    And the recording contains a "diagnostic" record with the code "malformed-packet"
