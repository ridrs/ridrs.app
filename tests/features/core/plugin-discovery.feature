@phase-1
Feature: Plugin discovery via manifest.json
  ridrs discovers plugins by scanning a plugin directory for manifest.json files.
  The manifest is the single source of truth for a plugin's identity, types,
  provided and required capabilities. Folder names are only a convention.

  Scenario: Every folder with a valid manifest becomes a known plugin
    Given a plugin directory containing:
      | folder    | id        | types             | provides | requires |
      | example-a | example-a | example           |          |          |
      | example-b | example-b | example, listener |          |          |
    When the host discovers plugins in the plugin directory
    Then the known plugins are "example-a, example-b"
    And the plugin "example-b" has the types "example, listener"
    And the discovery reported no problems

  Scenario: The manifest, not the folder name, defines the plugin
    Given a plugin directory containing:
      | folder      | id           | types  | provides | requires |
      | metric-fake | totally-else | device |          |          |
    When the host discovers plugins in the plugin directory
    Then the known plugins are "totally-else"
    And the plugin "totally-else" has the types "device"

  Scenario: A folder without a manifest is reported and skipped
    Given a plugin directory containing:
      | folder    | id        | types   | provides | requires |
      | example-a | example-a | example |          |          |
    And the plugin directory contains a folder "no-manifest" without a manifest.json
    When the host discovers plugins in the plugin directory
    Then the known plugins are "example-a"
    And the discovery reported a "missing-manifest" problem for folder "no-manifest"

  Scenario Outline: An invalid manifest is reported with the offending field and skipped
    Given a plugin directory containing:
      | folder    | id        | types   | provides | requires |
      | example-a | example-a | example |          |          |
    And the plugin directory contains a folder "broken" with the manifest '<manifest>'
    When the host discovers plugins in the plugin directory
    Then the known plugins are "example-a"
    And the discovery reported an "invalid-manifest" problem for folder "broken" mentioning "<field>"

    Examples:
      | manifest                                                                                                                           | field   |
      | {"name":"Broken","version":"1.0.0","types":["example"],"provides":[],"requires":[],"entry":"index.ts"}                             | id      |
      | {"id":"Broken Plugin","name":"Broken","version":"1.0.0","types":["example"],"provides":[],"requires":[],"entry":"index.ts"}        | id      |
      | {"id":"broken","name":"Broken","version":"one","types":["example"],"provides":[],"requires":[],"entry":"index.ts"}                 | version |
      | {"id":"broken","name":"Broken","version":"1.0.0","types":[],"provides":[],"requires":[],"entry":"index.ts"}                        | types   |
      | {"id":"broken","name":"Broken","version":"1.0.0","types":["example"],"provides":[],"requires":[]}                                  | entry   |
      | {"id":"broken","name":"Broken","version":"1.0.0","types":["example"],"provides":[],"requires":[],"entry":"index.ts","colour":"red"} | colour  |
      | { this is not json                                                                                                                 | JSON    |

  Scenario: Duplicate plugin ids are rejected
    Given a plugin directory containing:
      | folder   | id      | types   | provides | requires |
      | copy-one | same-id | example |          |          |
      | copy-two | same-id | example |          |          |
      | other    | other   | example |          |          |
    When the host discovers plugins in the plugin directory
    Then the known plugins are "other"
    And the discovery reported a "duplicate-id" problem for plugin "same-id" naming the folders "copy-one, copy-two"
