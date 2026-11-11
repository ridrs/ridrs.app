@ui
Feature: UI capabilities with typed input
  A UI capability is a component with typed input, provided by exactly one UI plugin and drawn
  by others with `ctx.render(capability, container, input)` (ADR 0083). The host decides what is
  shown, the provider how. The shell checks the declaration, parses the input before the
  provider sees it and the output before the consumer does, and mounts the provider whenever it
  is started: without it the consumer shows its own fallback (ADR 0053).

  The fixture capability is `ui.test-badge`: the input is a label and a tone, the output the
  event `picked`. The consumer's screen draws one badge, with "No badge here" as its fallback.

  Scenario: The consumer draws the badge with its input
    Given the badge fixtures "ui-badge, ui-badge-consumer" are composed
    When the badge consumer is shown
    Then the badge shows "Hello (calm)"
    And the badge provider was mounted 1 time

  Scenario: New input updates the badge without mounting it again
    Given the badge fixtures "ui-badge, ui-badge-consumer" are composed
    And the badge consumer is shown
    And the badge shows "Hello (calm)"
    When I press "Make the badge loud"
    Then the badge shows "Hello (loud)"
    And the badge provider was mounted 1 time
    And the badge provider was updated 1 time

  Scenario: An output event of the badge reaches the consumer
    Given the badge fixtures "ui-badge, ui-badge-consumer" are composed
    And the badge consumer is shown
    When I press "Pick the badge"
    Then the badge consumer says "Picked Hello"

  Scenario: Output that breaks the schema never reaches the consumer
    Given the badge fixtures "ui-badge, ui-badge-consumer" are composed
    And the badge consumer is shown
    When I press "Pick the badge wrongly"
    Then the badge itself says "invalid-event-payload"
    And the badge consumer says "Waiting"

  Scenario: Input that breaks the schema is refused before the provider sees it
    Given the badge fixtures "ui-badge, ui-badge-consumer" are composed
    And the badge consumer is shown
    And the badge shows "Hello (calm)"
    When I press "Send a broken badge"
    Then the badge consumer says "invalid-request"
    And the badge shows "Hello (calm)"
    And the badge provider was updated 0 times
    When I press "Render a broken badge"
    Then the badge consumer says "invalid-request"
    And the badge provider was mounted 1 time

  Scenario: A capability the consumer did not declare is refused
    Given the badge fixtures "ui-badge, ui-badge-consumer" are composed
    And the badge consumer is shown
    When I press "Render an undeclared badge"
    Then the badge consumer says "undeclared-capability"

  Scenario: Without a provider the consumer shows its fallback
    Given the badge fixtures "ui-badge-consumer" are composed
    When the badge consumer is shown
    Then the badge is unavailable and the consumer shows "No badge here"

  Scenario: A provider started later is mounted into the waiting consumer
    Given the badge fixtures "ui-badge, ui-badge-consumer" are composed
    And the plugin "fixture-ui-badge" is stopped
    And the badge consumer is shown
    And the badge is unavailable and the consumer shows "No badge here"
    When the plugin "fixture-ui-badge" is started
    Then the badge shows "Hello (calm)"
    And the badge provider was mounted 1 time

  Scenario: A stopped provider is released and the badge becomes unavailable
    Given the badge fixtures "ui-badge, ui-badge-consumer" are composed
    And the badge consumer is shown
    And the badge shows "Hello (calm)"
    When the plugin "fixture-ui-badge" is stopped
    Then the badge provider was released 1 time
    And the badge is unavailable and the consumer shows "No badge here"

  Scenario: Two providers of one UI capability are an error at start
    Given the badge fixtures "ui-badge, ui-badge-twin, ui-badge-consumer" are composed
    Then the host reported an "ambiguous-provider" problem for capability "ui.test-badge" naming the plugins "fixture-ui-badge, fixture-ui-badge-twin"
    And the plugins "fixture-ui-badge, fixture-ui-badge-twin" are in the state "blocked"
    And the plugin "fixture-ui-badge-consumer" is in the state "started"
    When the badge consumer is shown
    Then the badge is unavailable and the consumer shows "No badge here"

  Scenario: Leaving the consumer releases its badge
    Given the badge fixtures "ui-badge, ui-badge-consumer" are composed
    And the badge consumer is shown
    And the badge shows "Hello (calm)"
    When I press "Go elsewhere"
    Then the "elsewhere" screen is shown
    And the badge provider was released 1 time
    And no badge is shown
