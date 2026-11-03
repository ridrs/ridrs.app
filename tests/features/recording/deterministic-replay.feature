@phase-9 @fake-timers
Feature: A recorded ride is replayed deterministically
  The replay feeds the recorded bytes and the recorded rider input through the
  current plugins on a virtual clock and compares every derived event.

  Background:
    Given a simulated BLE environment with the Phase 2 trainer script "SIM KICKR" and a heart-rate band "SIM HRM"
    And the ridrs physics plugins, the device plugins, the metric plugins and "recording-session" together with a probe plugin "test-ui" and the memory storage
    And the host has started
    And 70 s pass
    And "test-ui" published "activity.start-requested" through the UI bridge
    And 30 s pass
    And "test-ui" published "activity.finish-requested" through the UI bridge

  Scenario: Replaying the unchanged code gives identical results
    When the recording is replayed
    Then the replay is identical
    And the replay compared every "device.raw-notification", "measurement.power", "measurement.cadence", "measurement.heart-rate", "metric.power", "metric.cadence", "metric.heart-rate", "metric.power-heart-rate-ratio", "physics.state" and "physics.state-batch" event of the ride
    And the replay reports no configuration differences

  Scenario: Replaying twice gives the same replay
    When the recording is replayed twice
    Then both replays are deep-equal

  Scenario: A changed rider shows where the results diverge
    When the recording is replayed with "physics-rider" replaced by a probe plugin "test-rider" that provides "physics.rider" with a mass of 95 kg and a CdA of 0.32 m²
    Then the replay is not identical
    And the first difference is in "physics.state" step 0 at the field "mass": 85 recorded, 105 replayed
    And the "metric.power" and "physics.state-batch" step 0 streams match up to their first difference
    And the replay reports that the configuration section "physics-rider" is missing
    And the replay reports that the plugin "physics-rider" is missing and "test-rider" was added

  Scenario: A changed plugin version is reported, and the replay still runs
    Given the recording's snapshot lists "physics-engine" with the version "0.0.1"
    When the recording is replayed
    Then the replay reports the plugin version change "physics-engine": "0.0.1" recorded, the current version now
    And the replay is identical

  Scenario: A recording from a newer format is refused
    Given the recording's header has the format version 2
    When the recording is replayed
    Then the replay failed with "recording-unsupported-version"

  Scenario: Unknown record kinds and unknown event types are kept
    Given the recording contains an extra record of the kind "marker"
    And the recording contains an event of the unknown type "future.thing" from the source "ui-bridge"
    When the recording is replayed
    Then the replay ignored the "marker" record
    And the replay republished "future.thing" as an input event
