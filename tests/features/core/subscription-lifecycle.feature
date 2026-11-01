@phase-1
Feature: Subscriptions end with the plugin
  When a plugin stops, the host removes all of its subscriptions.
  A stopped plugin neither receives nor publishes events.

  Background:
    Given the capability contracts:
      | capability | cardinality |
      | demo.clock | single      |
    And the event type "demo.greeting" with the payload schema:
      | field | type   |
      | text  | string |

  Scenario: A stopped plugin receives no more events
    Given the running plugins "sender, receiver"
    And "receiver" subscribes to "demo.greeting"
    When the plugin "receiver" is stopped
    And "sender" publishes "demo.greeting" with text "anyone there?"
    Then "receiver" received no events
    And the event bus holds no subscriptions of "receiver"

  Scenario: A stopped plugin cannot publish
    Given the running plugins "sender, receiver"
    And "receiver" subscribes to "demo.greeting"
    When the plugin "sender" is stopped
    And "sender" publishes "demo.greeting" with text "hello"
    Then the publication is rejected with a "plugin-not-active" error
    And "receiver" received no events

  Scenario: Stopping a provider stops its dependents first
    Given the plugins:
      | id    | provides   | requires   |
      | clock | demo.clock |            |
      | watch |            | demo.clock |
    And the host has started
    When the plugin "clock" is stopped
    Then the "stop" hooks were called in the order "watch, clock"
    And the plugins "watch, clock" are in the state "stopped"

  Scenario: Stopping the host removes every subscription
    Given the running plugins "sender, receiver, observer"
    And "receiver" subscribes to "demo.greeting"
    And "observer" subscribes to "demo.greeting"
    When the host stops
    Then the event bus holds no subscriptions
