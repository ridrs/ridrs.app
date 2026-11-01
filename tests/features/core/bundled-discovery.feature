@phase-3
Feature: Plugin discovery from a bundled plugin set
  Apps cannot read a plugin directory. They discover plugins from a set bundled at build time.
  The manifest stays the single source of truth; only the way manifests are found differs.

  Scenario: Every bundled plugin with a valid manifest becomes a known plugin
    Given a bundled plugin set containing:
      | folder    | id        | types             | provides | requires |
      | example-a | example-a | example           |          |          |
      | example-b | example-b | example, listener |          |          |
    When the host discovers the bundled plugins
    Then the known plugins are "example-a, example-b"
    And the plugin "example-b" has the types "example, listener"
    And the discovery reported no problems

  Scenario: An invalid bundled manifest is reported with the offending field and skipped
    Given a bundled plugin set containing:
      | folder    | id        | types   | provides | requires |
      | example-a | example-a | example |          |          |
    And the bundled plugin set contains a folder "broken" with the manifest '{"name":"Broken","version":"1.0.0","types":["example"],"provides":[],"requires":[],"entry":"index.ts"}'
    When the host discovers the bundled plugins
    Then the known plugins are "example-a"
    And the discovery reported an "invalid-manifest" problem for folder "broken" mentioning "id"

  Scenario: Duplicate plugin ids in the bundle are rejected
    Given a bundled plugin set containing:
      | folder   | id      | types   | provides | requires |
      | copy-one | same-id | example |          |          |
      | copy-two | same-id | example |          |          |
    When the host discovers the bundled plugins
    Then the known plugins are ""
    And the discovery reported a "duplicate-id" problem for plugin "same-id" naming the folders "copy-one, copy-two"

  Scenario: Bundled plugins are started through the real host
    Given a bundled plugin set containing:
      | folder    | id        | types   | provides | requires |
      | example-a | example-a | example |          |          |
    When the host starts
    Then the plugin "example-a" is in the state "started"

  Scenario: A manifest whose entry is not part of the bundle is reported
    Given a bundled plugin set containing:
      | folder | id    | types   | provides | requires |
      | ghost  | ghost | example |          |          |
    And the entry module of "ghost" is not part of the bundle
    When the host starts
    Then the host reported an "entry-load-failure" problem for plugin "ghost"
    And the plugin "ghost" is in the state "failed"
