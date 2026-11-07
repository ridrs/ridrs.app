@ui
Feature: UI clients watch app state and call services
  Client code watches the app state topics its manifest names in `ui.state` and calls the
  services in `ui.calls` (ADR 0068). It sees every entry first, then the changes; a call resolves,
  or rejects with a reason the UI can show. The UI bridge refuses everything no started UI plugin
  declares.

  Background:
    Given a probe plugin "source-a" of type "transport" that owns "test.offer", sets "source-a/col" when it starts and provides "test.fetch"
    And a probe plugin "source-b" of type "storage" that owns "test.offer", sets "source-b/col" when it starts and provides "test.fetch" failing with "Source B is offline"
    And the plugin directory "tests/fixtures/plugins/app-state-ui" is added and its plugin "fixture-ui-app-state" is started

  Scenario: The UI shows every entry first, then the changes
    Then the page lists the offers "source-a/col: source-a/col, source-b/col: source-b/col"
    When "source-a" sets the "test.offer" state "source-a/col" to '{"title":"Col","progress":0.5}'
    Then the page lists the offers "source-a/col: Col 50 %, source-b/col: source-b/col"
    When the plugin "source-b" is stopped
    Then the page lists the offers "source-a/col: Col 50 %"

  Scenario: A call from the UI resolves
    When I press "Fetch source-a/col"
    Then the page shows the status "Fetching source-a/col"
    And "source-a" handled 1 "test.fetch" call

  Scenario: A rejected call from the UI says why
    When I press "Fetch source-b/col"
    Then the page shows the status "service-failed: Source B is offline"
    And "source-a" handled 0 "test.fetch" calls

  Scenario: The UI bridge refuses topics and services no UI plugin declares
    Then the UI bridge refuses to watch "test.other" with "state-not-allowed"
    And the UI bridge refuses to call "test.ping" with "call-not-allowed"
