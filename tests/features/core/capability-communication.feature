@phase-1
Feature: Plugins talk to each other through capability contracts
  A plugin uses functionality of another plugin only through a declared
  capability contract - never by importing the other plugin's code.

  Background:
    Given the capability contracts:
      | capability   | cardinality |
      | demo.clock   | single      |
      | demo.greeter | multiple    |

  Scenario: A plugin uses the implementation behind a single capability
    Given the plugins:
      | id    | provides   | requires   |
      | clock | demo.clock |            |
      | watch |            | demo.clock |
    And "clock" implements "demo.clock" telling the time "12:00"
    When the host starts
    And "watch" asks "demo.clock" for the time
    Then "watch" gets the answer "12:00"

  Scenario: A plugin uses all implementations behind a multiple capability
    Given the plugins:
      | id      | provides     | requires     |
      | german  | demo.greeter |              |
      | english | demo.greeter |              |
      | lobby   |              | demo.greeter |
    And "english" implements "demo.greeter" greeting with "Hello"
    And "german" implements "demo.greeter" greeting with "Hallo"
    When the host starts
    And "lobby" asks every "demo.greeter" to greet "Ada"
    Then "lobby" gets the answers "Hello, Ada; Hallo, Ada"

  Scenario: Using a capability that is not declared in requires is refused
    Given the plugins:
      | id     | provides   | requires |
      | clock  | demo.clock |          |
      | sneaky |            |          |
    And "clock" implements "demo.clock" telling the time "12:00"
    When the host starts
    And "sneaky" asks "demo.clock" for the time
    Then the request is refused with an "undeclared-capability" error

  Scenario: Providing a capability that is not declared in provides is refused
    Given the plugins:
      | id    | provides   | requires |
      | clock | demo.clock |          |
    And "clock" implements "demo.clock" telling the time "12:00"
    And "clock" also tries to implement "demo.greeter" during initialize
    When the host starts
    Then the plugin "clock" is in the state "failed"
    And the host reported an "undeclared-capability" problem for plugin "clock" mentioning "demo.greeter"

  Scenario: A provider that does not deliver its declared capability fails
    Given the plugins:
      | id    | provides   | requires   |
      | clock | demo.clock |            |
      | watch |            | demo.clock |
    And "clock" does not implement "demo.clock" during initialize
    When the host starts
    Then the plugin "clock" is in the state "failed"
    And the host reported a "capability-not-provided" problem for plugin "clock" mentioning "demo.clock"
    And the plugin "watch" is in the state "blocked"
