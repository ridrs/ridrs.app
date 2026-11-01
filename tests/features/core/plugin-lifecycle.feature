@phase-1
Feature: Plugin lifecycle
  Every plugin passes through initialize, start, stop and dispose.
  The host drives these hooks in dependency order and isolates failures.

  Background:
    Given the capability contracts:
      | capability | cardinality |
      | demo.clock | single      |

  Scenario: The host drives the complete lifecycle in dependency order
    Given the plugins:
      | id    | provides   | requires   |
      | clock | demo.clock |            |
      | watch |            | demo.clock |
    When the host starts
    And the host stops
    And the host is disposed
    Then the lifecycle hooks were called in this order:
      | plugin | hook       |
      | clock  | initialize |
      | watch  | initialize |
      | clock  | start      |
      | watch  | start      |
      | watch  | stop       |
      | clock  | stop       |
      | watch  | dispose    |
      | clock  | dispose    |
    And all plugins are in the state "disposed"

  Scenario: Asynchronous hooks are awaited before dependents continue
    Given the plugins:
      | id    | provides   | requires   |
      | clock | demo.clock |            |
      | watch |            | demo.clock |
    And the "start" hook of "clock" completes asynchronously
    When the host starts
    Then the "start" hook of "clock" completed before the "start" hook of "watch" was called

  Scenario Outline: A plugin failing in <hook> does not take down the host
    Given the plugins:
      | id        | provides   | requires   |
      | clock     | demo.clock |            |
      | watch     |            | demo.clock |
      | bystander |            |            |
    And the "<hook>" hook of "clock" throws "battery empty"
    When the host starts
    Then the host is running
    And the plugin "clock" is in the state "failed"
    And the host reported a "lifecycle-failure" problem for plugin "clock" mentioning "battery empty"
    And the plugin "watch" is in the state "blocked"
    And the "start" hook of "watch" was not called
    And the plugin "bystander" is in the state "started"

    Examples:
      | hook       |
      | initialize |
      | start      |

  Scenario: A failing stop hook does not prevent the others from shutting down
    Given the plugins:
      | id    | provides   | requires   |
      | clock | demo.clock |            |
      | watch |            | demo.clock |
    And the "stop" hook of "clock" throws "stuck"
    When the host starts
    And the host stops
    And the host is disposed
    Then the host reported a "lifecycle-failure" problem for plugin "clock" mentioning "stuck"
    And the plugin "watch" is in the state "disposed"
    And the "dispose" hook of "clock" was called

  Scenario: A plugin whose entry module cannot be loaded fails
    Given the plugins:
      | id        | provides | requires |
      | ghost     |          |          |
      | bystander |          |          |
    And the entry module of "ghost" does not exist
    When the host starts
    Then the plugin "ghost" is in the state "failed"
    And the host reported an "entry-load-failure" problem for plugin "ghost"
    And the plugin "bystander" is in the state "started"
