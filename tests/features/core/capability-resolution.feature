@phase-1
Feature: Capability resolution
  Plugins declare what they provide and what they require.
  The host resolves these declarations, determines a valid start order
  and refuses to start plugins whose requirements cannot be satisfied.

  Background:
    Given the capability contracts:
      | capability   | cardinality |
      | demo.clock   | single      |
      | demo.store   | single      |
      | demo.greeter | multiple    |

  Scenario: Plugins are initialized and started after their providers
    Given the plugins:
      | id      | provides   | requires   |
      | archive |            | demo.store |
      | store   | demo.store | demo.clock |
      | clock   | demo.clock |            |
    When the host starts
    Then the plugins were initialized in the order "clock, store, archive"
    And the plugins were started in the order "clock, store, archive"
    And all plugins are in the state "started"

  Scenario: Independent plugins start in a deterministic order
    Given the plugins:
      | id    | provides | requires |
      | zulu  |          |          |
      | alpha |          |          |
      | mike  |          |          |
    When the host starts
    Then the plugins were started in the order "alpha, mike, zulu"

  Scenario: A missing capability blocks the plugin and everything that depends on it
    Given the plugins:
      | id        | provides   | requires   |
      | store     | demo.store | demo.clock |
      | archive   |            | demo.store |
      | bystander |            |            |
    When the host starts
    Then the host reported a "missing-capability" problem for plugin "store" mentioning "demo.clock"
    And the plugins "store, archive" are in the state "blocked"
    And no lifecycle hook of "store, archive" was called
    And the plugin "bystander" is in the state "started"

  Scenario: A dependency cycle is detected
    Given the plugins:
      | id        | provides   | requires   |
      | clock     | demo.clock | demo.store |
      | store     | demo.store | demo.clock |
      | bystander |            |            |
    When the host starts
    Then the host reported a "dependency-cycle" problem involving the plugins "clock, store"
    And the plugins "clock, store" are in the state "blocked"
    And the plugin "bystander" is in the state "started"

  Scenario: All providers of a multiple capability are available
    Given the plugins:
      | id      | provides     | requires     |
      | english | demo.greeter |              |
      | german  | demo.greeter |              |
      | lobby   |              | demo.greeter |
    When the host starts
    Then the plugin "lobby" was initialized after "english, german"
    And all plugins are in the state "started"

  Scenario: Two providers of a single capability are a conflict
    Given the plugins:
      | id        | provides   | requires   |
      | clock-a   | demo.clock |            |
      | clock-b   | demo.clock |            |
      | watch     |            | demo.clock |
      | bystander |            |            |
    When the host starts
    Then the host reported an "ambiguous-provider" problem for capability "demo.clock" naming the plugins "clock-a, clock-b"
    And the plugins "clock-a, clock-b, watch" are in the state "blocked"
    And the plugin "bystander" is in the state "started"

  Scenario: A capability without a registered contract is rejected
    Given the plugins:
      | id      | provides | requires     |
      | dreamer |          | demo.unicorn |
    When the host starts
    Then the host reported an "unknown-capability" problem for plugin "dreamer" mentioning "demo.unicorn"
    And the plugin "dreamer" is in the state "blocked"
