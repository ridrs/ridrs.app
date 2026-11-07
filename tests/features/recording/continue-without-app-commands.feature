@phase-9 @fake-timers
Feature: A continued ride does not do the app's work again
  Continuing an interrupted ride (ADR 0057) re-executes the inputs of its journal. The journal
  holds the ride: rider input that changes it, device data, results of the simulation. App
  commands and app state are not part of a ride: a download or an upload asked for during the
  ride, or in the minute before it, must not happen again when the ride goes on, and the app's
  state does not fill the recording (ADR 0068, ridrs_elephant/prompts/14-app-state-and-services.md).

  Stage 0 of the brief showed the problem with these scenarios (`@wip` until stage 3). Since
  stages 2 and 3 the download and the upload are service calls and the progress is app state:
  none of them is on the bus, so none is recorded or done again. What is checked is unchanged.

  Background:
    Given the ridrs physics plugins, "recording-session" and "export-fit" together with a test device plugin "test-device", a probe plugin "test-ui" and the memory storage
    And "test-app" is a probe plugin that offers the route "test-app/col-de-pennes" and the training account "test-app", and answers "route.fetch" and "training.upload"
    And "test-services" is a probe device plugin that answers "bridge.pair"
    And the host has started

  Scenario: A download asked for during the ride is not asked for again when the ride continues
    Given "test-ui" published "activity.start-requested" through the UI bridge
    And the UI bridge called "route.fetch" with '{"key":"test-app/col-de-pennes"}'
    And "test-device" delivered only power 200 W every 0.25 s for 30 seconds
    And the machine lost power
    And 60 s pass
    And ridrs started again
    When the rider continues the interrupted ride
    Then "test-app" received the "route.fetch" only once

  Scenario: An upload asked for just before the ride is not sent again when the ride continues
    Given the UI bridge called "training.upload" with '{"key":"test-app","sessionId":"s-earlier","file":"recordings/earlier.fit"}'
    And "test-ui" published "activity.start-requested" through the UI bridge
    And "test-device" delivered only power 200 W every 0.25 s for 30 seconds
    And the machine lost power
    And 60 s pass
    And ridrs started again
    When the rider continues the interrupted ride
    Then "test-app" received the "training.upload" only once

  Scenario: The recording of a ride holds no app state
    Given "test-ui" published "activity.start-requested" through the UI bridge
    And "test-app" reported the progress of its route 10 times
    And "test-device" delivered only power 200 W every 0.25 s for 30 seconds
    Then the open recording on the disk holds no "route.offers-changed" event
    And the open recording on the disk holds nothing of the "route.offer" state

  Scenario: A device forgotten during the ride is not forgotten again when the ride continues
    Given "test-services" reported its "heart-rate" "HRM-Pro 42" as "connected"
    And "test-ui" published "activity.start-requested" through the UI bridge
    And the rider forgot the "heart-rate"
    And "test-device" delivered only power 200 W every 0.25 s for 30 seconds
    And the machine lost power
    And 60 s pass
    And ridrs started again
    When the rider continues the interrupted ride
    Then "test-services" received the "device.forget" only once

  Scenario: A pairing just before the ride is neither recorded nor done again when the ride continues
    Given the UI bridge called "bridge.pair" with '{"address":"192.168.1.20:7000","code":"483920"}'
    And "test-ui" published "activity.start-requested" through the UI bridge
    And "test-device" delivered only power 200 W every 0.25 s for 30 seconds
    Then the open recording on the disk does not contain "483920"
    When the machine lost power
    And 60 s pass
    And ridrs started again
    And the rider continues the interrupted ride
    Then "test-services" received the "bridge.pair" only once

  Scenario: The FIT file of a ride saved just before the next one is not written again when that ride continues
    Given "test-ui" published "activity.start-requested" through the UI bridge
    And "test-device" delivered only power 200 W every 0.25 s for 10 seconds
    And "test-ui" published "activity.finish-requested" through the UI bridge
    And the FIT file of that ride was written
    And "test-ui" published "activity.start-requested" through the UI bridge
    And "test-device" delivered only power 200 W every 0.25 s for 30 seconds
    And the machine lost power
    And 60 s pass
    And ridrs started again
    When the rider continues the interrupted ride
    Then the FIT file of the first ride was written only once
