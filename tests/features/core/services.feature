@core
Feature: Plugins answer requests as services, beside the simulation bus
  A service (ADR 0068) is a request with an answer or an error, for what the app does: download,
  upload, connect. A service without a key has one provider; a keyed service goes to the plugin
  that owns the key in its topic. Requests and answers are checked against the service. Only
  plugins on the input side provide or call services, as their manifest declares. Calls are not
  part of a ride: a continued ride never makes them again.

  Scenario: A call reaches the single provider and resolves with its answer
    Given a probe plugin "test-pinger" of type "transport" that provides "test.ping"
    And the host has started
    When the UI bridge calls "test.ping" with '{"text":"hello"}'
    Then the call resolved with '{"echo":"hello"}'
    And "test-pinger" handled 1 "test.ping" call

  Scenario: A keyed call reaches the owner of the key
    Given a probe plugin "source-a" of type "transport" that owns "test.offer", sets "source-a/col" when it starts and provides "test.fetch"
    And a probe plugin "source-b" of type "storage" that owns "test.offer", sets "source-b/col" when it starts and provides "test.fetch"
    And the host has started
    When the UI bridge calls "test.fetch" with '{"key":"source-b/col"}'
    Then the call resolved with '{}'
    And "source-b" handled 1 "test.fetch" call
    And "source-a" handled 0 "test.fetch" calls

  Scenario: A call for a key nobody owns is rejected
    Given a probe plugin "source-a" of type "transport" that owns "test.offer", sets "source-a/col" when it starts and provides "test.fetch"
    And the host has started
    When the UI bridge calls "test.fetch" with '{"key":"nobody/col"}'
    Then the call was rejected with "unknown-key"
    And "source-a" handled 0 "test.fetch" calls

  Scenario: A handler's error rejects the call with its message
    Given a probe plugin "test-pinger" of type "transport" that provides "test.ping" and fails with "The pinger is tired"
    And the host has started
    When the UI bridge calls "test.ping" with '{"text":"hello"}'
    Then the call was rejected with "service-failed" and the message "The pinger is tired"

  Scenario: An invalid request is refused before the handler
    Given a probe plugin "test-pinger" of type "transport" that provides "test.ping"
    And the host has started
    When the UI bridge calls "test.ping" with '{"text":42}'
    Then the call was rejected with "invalid-request"
    And "test-pinger" handled 0 "test.ping" calls

  Scenario: Two providers of a service without a key are ambiguous and both blocked
    Given a probe plugin "pinger-a" of type "transport" that provides "test.ping"
    And a probe plugin "pinger-b" of type "storage" that provides "test.ping"
    When the host starts
    Then the host reported an "ambiguous-service" problem involving the plugins "pinger-a, pinger-b"
    And the plugins "pinger-a, pinger-b" are in the state "blocked"

  Scenario: A call to a stopped provider is rejected
    Given a probe plugin "test-pinger" of type "transport" that provides "test.ping"
    And the host has started
    When the plugin "test-pinger" is stopped
    And the UI bridge calls "test.ping" with '{"text":"hello"}'
    Then the call was rejected with "service-unavailable"

  Scenario: A plugin calls the services its manifest declares, and no others
    Given a probe plugin "test-pinger" of type "transport" that provides "test.ping"
    And a probe plugin "test-caller" of type "ui" that calls "test.ping"
    And the host has started
    When "test-caller" calls "test.ping" with '{"text":"hello"}'
    Then the call resolved with '{"echo":"hello"}'
    When "test-caller" calls "test.fetch" with '{"key":"source-a/col"}'
    Then the call was rejected with "undeclared-service"

  Scenario: A simulation plugin may not declare services
    Given a plugin folder "physics-probe" whose manifest declares the types "physics" and provides the service "test.ping"
    When the host discovers plugins in the plugin directory
    Then the discovery reported an "invalid-manifest" problem for folder "physics-probe" mentioning "services"

  Scenario: A simulation plugin cannot call services
    Given a probe plugin "test-pinger" of type "transport" that provides "test.ping"
    And a probe plugin "test-physics" of type "physics"
    And the host has started
    When "test-physics" calls "test.ping" with '{"text":"hello"}'
    Then the call was rejected with "permission-denied"
    And "test-pinger" handled 0 "test.ping" calls

  Scenario: A composition root provides a service itself
    Given the composition root provides "test.ping"
    And the host has started
    When the UI bridge calls "test.ping" with '{"text":"hello"}'
    Then the call resolved with '{"echo":"hello"}'

  Scenario: A composition root and a plugin cannot both provide a service without a key
    Given a probe plugin "test-pinger" of type "transport" that provides "test.ping"
    And the host has started
    When the composition root provides "test.ping"
    Then providing it failed with "ambiguous-service"

  @phase-9 @fake-timers
  Scenario: A call made during a ride is not made again when the ride continues
    Given the ridrs physics plugins, "recording-session" and "export-fit" together with a test device plugin "test-device", a probe plugin "test-ui" and the memory storage
    And a probe plugin "test-pinger" of type "transport" that provides "test.ping"
    And the host has started
    And "test-ui" published "activity.start-requested" through the UI bridge
    And the UI bridge called "test.ping" with '{"text":"download"}'
    And "test-device" delivered only power 200 W every 0.25 s for 30 seconds
    And the machine lost power
    And 60 s pass
    And ridrs started again
    When the rider continues the interrupted ride
    Then "test-pinger" handled 1 "test.ping" call
