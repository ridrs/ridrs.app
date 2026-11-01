@phase-1
Feature: Typed in-memory events between plugins
  Plugins communicate by publishing and subscribing to typed events.
  A publisher never knows who is listening.

  Background:
    Given the event type "demo.greeting" with the payload schema:
      | field | type   |
      | text  | string |
    And the event type "demo.reply" with the payload schema:
      | field | type   |
      | text  | string |
    And the running plugins "sender, receiver, observer"

  Scenario: One plugin publishes, another plugin receives
    Given "receiver" subscribes to "demo.greeting"
    When "sender" publishes "demo.greeting" with text "hello"
    Then "receiver" received exactly these events:
      | type          | text  | source |
      | demo.greeting | hello | sender |
    And every event received by "receiver" carries an id and the current time of the host clock

  Scenario: Every subscriber receives the same event
    Given "receiver" subscribes to "demo.greeting"
    And "observer" subscribes to "demo.greeting"
    When "sender" publishes "demo.greeting" with text "hello"
    Then "receiver" received 1 "demo.greeting" event
    And "observer" received 1 "demo.greeting" event
    And "receiver" and "observer" received the same event id

  Scenario: Subscribers only receive the event types they subscribed to
    Given "receiver" subscribes to "demo.reply"
    When "sender" publishes "demo.greeting" with text "hello"
    Then "receiver" received no events

  Scenario: Events published during delivery are dispatched after the current event
    Given "receiver" subscribes to "demo.greeting" and answers each greeting with a "demo.reply" echoing the text
    And "observer" subscribes to "demo.greeting"
    And "observer" subscribes to "demo.reply"
    When "sender" publishes "demo.greeting" with text "one"
    And "sender" publishes "demo.greeting" with text "two"
    Then "observer" received exactly these events:
      | type          | text | source   |
      | demo.greeting | one  | sender   |
      | demo.reply    | one  | receiver |
      | demo.greeting | two  | sender   |
      | demo.reply    | two  | receiver |

  Scenario: An invalid payload is rejected before delivery
    Given "receiver" subscribes to "demo.greeting"
    When "sender" publishes "demo.greeting" with the payload '{"text": 42}'
    Then the publication is rejected with an "invalid-event-payload" error mentioning "text"
    And "receiver" received no events

  Scenario: A failing subscriber affects neither the publisher nor other subscribers
    Given "receiver" subscribes to "demo.greeting" and throws "boom" while handling it
    And "observer" subscribes to "demo.greeting"
    When "sender" publishes "demo.greeting" with text "hello"
    Then the publication succeeded
    And "observer" received 1 "demo.greeting" event
    And the host reported an "event-handler-failure" problem for plugin "receiver" mentioning "boom"
    And the plugin "receiver" is in the state "started"

  Scenario: A plugin can cancel its own subscription
    Given "receiver" subscribes to "demo.greeting"
    When "receiver" cancels its subscription to "demo.greeting"
    And "sender" publishes "demo.greeting" with text "hello"
    Then "receiver" received no events
