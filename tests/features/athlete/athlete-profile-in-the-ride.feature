@fake-timers
Feature: The athlete profile is frozen for a ride
  The chosen data source's athlete profile (ADR 0073) enters a ride as an input, as the bicycle
  does (ADR 0060): the owner of the data source choice, the host side of the settings plugin,
  hands over "athlete.profile-changed" at host start and after every change of the chosen profile.
  When a ride starts, the activity session freezes it for that ride ("activity.athlete"), and the
  rider's weight in the physics is the frozen one until the ride ends. A change applies to the
  next ride. The recording keeps the input, so a replay and a continued ride use the recorded
  weight. Without a weight (no profile, or a source that cannot be read) the physics keeps its
  default of 75 kg.

  Background:
    Given the ridrs physics plugins, "recording-session" and "ui-settings" together with a test device plugin "test-device", a probe plugin "test-ui" and the memory storage
    And the plugins "profile-local" are loaded as well
    And the test data source plugin is installed
    And a mock world "test-road" feeds the terrain ahead with a constant gradient of 5 % when the ride starts

  Scenario Outline: A heavier rider climbs slower
    Given the athlete profile on this device holds a weight of <rider> kg
    And the host has started
    And "test-ui" published "activity.start-requested" through the UI bridge
    When "test-device" delivers only power 200 W every 0.25 s for 60 seconds
    Then the ride froze an athlete of <rider> kg from "ridrs"
    And the latest physics state carries a total mass of <total> kg
    And the virtual speed at "+60 s" is <speed> km/h

    Examples:
      | rider | total | speed |
      | 65    | 75    | 16.45 |
      | 85    | 95    | 13.57 |

  Scenario: Without a profile the rider weighs the default 75 kg
    Given the host has started
    And "test-ui" published "activity.start-requested" through the UI bridge
    When "test-device" delivers only power 200 W every 0.25 s for 10 seconds
    Then the ride froze an athlete without a weight from "ridrs"
    And the latest physics state carries a total mass of 85 kg

  Scenario: The profile is handed to the next ride at host start
    Given the athlete profile on this device holds an FTP of 230 W and a weight of 80.5 kg
    And the host has started
    Then the latest athlete handed to the next ride is from "ridrs" with an FTP of 230 W and a weight of 80.5 kg

  Scenario: A change in the profile is handed to the next ride
    Given the host has started
    When the rider changes the weight in the athlete profile on this device to 70 kg
    Then the latest athlete handed to the next ride is from "ridrs" with a weight of 70 kg

  Scenario: A change during a ride applies to the next ride
    Given the athlete profile on this device holds a weight of 65 kg
    And the host has started
    And "test-ui" published "activity.start-requested" through the UI bridge
    When the rider changes the weight in the athlete profile on this device to 85 kg
    And "test-device" delivers only power 200 W every 0.25 s for 10 seconds
    Then the latest physics state carries a total mass of 75 kg
    When "test-ui" publishes "activity.finish-requested" through the UI bridge
    And "test-ui" publishes "activity.start-requested" through the UI bridge
    And "test-device" delivers only power 200 W every 0.25 s for 5 seconds
    Then the ride froze an athlete of 85 kg from "ridrs"
    And the latest physics state carries a total mass of 95 kg

  Scenario: The chosen source's weight is the ride's
    Given the test data source offers a weight of 90 kg
    And the host has started
    When the rider chooses the athlete profile of "fixture-cloud"
    And "test-ui" published "activity.start-requested" through the UI bridge
    And "test-device" delivers only power 200 W every 0.25 s for 10 seconds
    Then the ride froze an athlete of 90 kg from "fixture-cloud"
    And the latest physics state carries a total mass of 100 kg

  Scenario: A source that cannot be read gives the ride the defaults
    Given the test data source is unavailable
    And the athlete profile on this device holds a weight of 65 kg
    And the rider chose the athlete profile of "fixture-cloud"
    And the host has started
    And "test-ui" published "activity.start-requested" through the UI bridge
    When "test-device" delivers only power 200 W every 0.25 s for 10 seconds
    Then the ride froze an athlete without a weight from "fixture-cloud"
    And the latest physics state carries a total mass of 85 kg

  Scenario: The recording reports the frozen weight
    Given the athlete profile on this device holds a weight of 65 kg
    And the host has started
    And "test-ui" published "activity.start-requested" through the UI bridge
    And "test-device" delivered only power 200 W every 0.25 s for 10 seconds
    When "test-ui" publishes "activity.finish-requested" through the UI bridge
    Then the snapshot section "physics-rider" reports a mass of 65 with the origin "profile"

  Scenario: The replay uses the recorded weight, whatever the profile holds now
    Given the athlete profile on this device holds a weight of 65 kg
    And the host has started
    And "test-ui" published "activity.start-requested" through the UI bridge
    And "test-device" delivered only power 200 W every 0.25 s for 10 seconds
    And "test-ui" published "activity.finish-requested" through the UI bridge
    When the rider changes the weight in the athlete profile on this device to 90 kg
    And the recording is replayed
    Then the replay is identical
    And the replay compared all of the "activity.athlete" and "physics.state" events of the ride

  Scenario: The recording keeps the athlete handed over long before the ride
    Given the athlete profile on this device holds a weight of 65 kg
    And the host has started
    And 120 seconds pass
    And "test-ui" published "activity.start-requested" through the UI bridge
    And "test-device" delivered only power 200 W every 0.25 s for 10 seconds
    And "test-ui" published "activity.finish-requested" through the UI bridge
    When the recording is replayed
    Then the replay is identical
    And the replay compared all of the "activity.athlete" and "physics.state" events of the ride

  Scenario: A recording without a profile replays with the default weight
    Given the plugin "ui-settings" is not installed
    And the host has started
    And "test-ui" published "activity.start-requested" through the UI bridge
    And "test-device" delivered only power 200 W every 0.25 s for 10 seconds
    And "test-ui" published "activity.finish-requested" through the UI bridge
    When the recording is replayed
    Then the replay is identical
    And the ride froze no athlete
    And the latest physics state carries a total mass of 85 kg

  Scenario: A continued ride keeps its frozen weight
    Given the athlete profile on this device holds a weight of 65 kg
    And the host has started
    And "test-ui" published "activity.start-requested" through the UI bridge
    And "test-device" delivered only power 200 W every 0.25 s for 30 seconds
    And the machine lost power
    And the athlete profile on this device holds a weight of 90 kg
    And ridrs started again
    When the rider continues the interrupted ride
    And "test-ui" publishes "activity.resume-requested" through the UI bridge
    And "test-device" delivers only power 200 W every 0.25 s for 10 seconds
    Then the latest physics state carries a total mass of 75 kg
    When "test-ui" publishes "activity.finish-requested" through the UI bridge
    And the recording is replayed
    Then the replay is identical

  Scenario: The next ride after a continued one uses the profile as it is now
    Given the athlete profile on this device holds a weight of 65 kg
    And the host has started
    And "test-ui" published "activity.start-requested" through the UI bridge
    And "test-device" delivered only power 200 W every 0.25 s for 30 seconds
    And the machine lost power
    And the athlete profile on this device holds a weight of 90 kg
    And ridrs started again
    When the rider continues the interrupted ride
    And "test-ui" publishes "activity.finish-requested" through the UI bridge
    And "test-ui" publishes "activity.start-requested" through the UI bridge
    Then the ride froze an athlete of 90 kg from "ridrs"
