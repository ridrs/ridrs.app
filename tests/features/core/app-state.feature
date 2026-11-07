@core
Feature: Plugins share app state by key, beside the simulation bus
  App state (ADR 0068) is the current value of the app's things by key: offers, accounts, the
  progress of a download. One plugin owns a key; every value is checked against its topic when it
  is written. A watcher sees every entry first, then only the keys changed since, each once per
  tick with its last value. Only plugins on the input side own or watch state, as their manifest
  declares. App state is not part of a ride: it is never recorded.

  Scenario: A watcher sees every entry first, then only the changed keys
    Given a probe plugin "test-source" of type "transport" that owns "test.offer" and sets "col-a, col-b" when it starts
    And a probe plugin "test-watcher" of type "ui" that watches "test.offer"
    And the host has started
    Then the first "test.offer" delivery to "test-watcher" changed "col-a, col-b" and holds "col-a, col-b"
    When "test-source" sets the "test.offer" state "col-b" to '{"title":"Col B","progress":0.5}'
    Then the latest "test.offer" delivery to "test-watcher" changed "col-b" and holds "col-a, col-b"
    And the "test.offer" state "col-b" is '{"title":"Col B","progress":0.5}'

  @fake-timers
  Scenario: Ten writes of one key in one turn arrive as one change with the last value
    Given a probe plugin "test-source" of type "transport" that owns "test.offer" and sets "col-a" when it starts
    And a probe plugin "test-watcher" of type "ui" that watches "test.offer"
    And the host has started
    When "test-source" sets the "test.offer" state "col-a" 10 times in one turn, its progress rising to 1
    Then "test-watcher" received 2 "test.offer" deliveries
    And the latest "test.offer" delivery to "test-watcher" changed "col-a" to '{"title":"col-a","progress":1}'

  Scenario: A second owner of a key is refused
    Given a probe plugin "test-source" of type "transport" that owns "test.offer" and sets "col-a" when it starts
    And a probe plugin "test-other" of type "storage" that owns "test.offer"
    And the host has started
    When "test-other" sets the "test.offer" state "col-a" to '{"title":"Mine"}'
    Then the state write failed with "state-key-owned" mentioning "test-source"
    And the "test.offer" state "col-a" is '{"title":"col-a"}'

  Scenario: An invalid value is refused with its path
    Given a probe plugin "test-source" of type "transport" that owns "test.offer"
    And the host has started
    When "test-source" sets the "test.offer" state "col-a" to '{"title":"Col A","progress":2}'
    Then the state write failed with "invalid-state-value" mentioning "progress"
    And the "test.offer" state holds no "col-a"

  Scenario: A stopped owner's keys are removed, and its watchers see it
    Given a probe plugin "test-source" of type "transport" that owns "test.offer" and sets "col-a, col-b" when it starts
    And a probe plugin "test-watcher" of type "ui" that watches "test.offer"
    And the host has started
    When the plugin "test-source" is stopped
    Then the latest "test.offer" delivery to "test-watcher" changed "col-a, col-b" and holds nothing
    And the "test.offer" state holds no "col-a"

  Scenario: A simulation plugin may not declare state
    Given a plugin folder "physics-probe" whose manifest declares the types "physics" and owns the state "test.offer"
    When the host discovers plugins in the plugin directory
    Then the discovery reported an "invalid-manifest" problem for folder "physics-probe" mentioning "state"

  Scenario: A device plugin may not watch app state: it runs in a replay
    Given a plugin folder "device-probe" whose manifest declares the types "device" and watches the state "test.offer"
    When the host discovers plugins in the plugin directory
    Then the discovery reported an "invalid-manifest" problem for folder "device-probe" mentioning "replay"

  Scenario: A recording plugin may own app state
    Given a probe plugin "test-recorder" of type "recording" that owns "test.offer" and sets "ride-a" when it starts
    And the host has started
    Then the "test.offer" state "ride-a" is '{"title":"ride-a"}'

  Scenario: A simulation plugin cannot reach app state
    Given a probe plugin "test-physics" of type "physics"
    And the host has started
    When "test-physics" sets the "test.offer" state "col-a" to '{"title":"Col A"}'
    Then the state write failed with "permission-denied"

  Scenario: A topic the manifest does not declare is refused
    Given a probe plugin "test-source" of type "transport" that owns "test.offer"
    And the host has started
    When "test-source" sets the "test.other" state "x" to '{"title":"X"}'
    Then the state write failed with "undeclared-state"

  Scenario: A manifest that names an unknown topic blocks its plugin
    Given a probe plugin "test-source" of type "transport" that owns "test.nowhere"
    When the host starts
    Then the host reported an "unknown-state" problem for plugin "test-source" mentioning "test.nowhere"
    And the plugin "test-source" is in the state "blocked"

  @phase-9 @fake-timers
  Scenario: The recording of a ride during which state was written holds none of it
    Given the ridrs physics plugins, "recording-session" and "export-fit" together with a test device plugin "test-device", a probe plugin "test-ui" and the memory storage
    And a probe plugin "test-source" of type "transport" that owns "test.offer"
    And the host has started
    And "test-ui" published "activity.start-requested" through the UI bridge
    And "test-source" set the "test.offer" state "col-a" 10 times in one turn, its progress rising to 1
    And "test-device" delivered only power 200 W every 0.25 s for 30 seconds
    Then the "test.offer" state "col-a" is '{"title":"col-a","progress":1}'
    And the open recording on the disk holds nothing of the "test.offer" state
