@phase-3
Feature: UI registry built from plugin manifests
  Screens, extension points and contributions are declared in the manifest.
  The core indexes them for the plugins that are currently started - and knows
  nothing about what any of them means.

  Scenario: A screen and its extension points are registered
    Given the plugin "screen-a" with the UI manifest:
      """
      { "client": "client/index.js",
        "screens": [ { "id": "activity", "export": "Screen",
                       "extensionPoints": ["activity/landscape", "activity/hud"] } ] }
      """
    When the host starts
    Then the UI registry contains the screen "activity" from the plugin "screen-a"
    And the UI registry contains the extension points "activity/landscape, activity/hud"

  Scenario: Contributions are ordered by order, then plugin id, then contribution id
    Given the plugin "screen-a" with the UI manifest:
      """
      { "client": "client/index.js",
        "screens": [ { "id": "activity", "export": "Screen", "extensionPoints": ["activity/hud"] } ] }
      """
    And the plugin "zeta" contributes "w1" to "activity/hud" with order 0
    And the plugin "alpha" contributes "w2" to "activity/hud" with order 1
    And the plugin "beta" contributes "w1" to "activity/hud" with order 0
    And the plugin "beta" contributes "w0" to "activity/hud" with order 0
    When the host starts
    Then the contributions to "activity/hud" are in this order:
      | plugin | contribution |
      | beta   | w0           |
      | beta   | w1           |
      | zeta   | w1           |
      | alpha  | w2           |

  Scenario: A contribution can offer extension points of its own
    Given the plugin "screen-a" with the UI manifest:
      """
      { "client": "client/index.js",
        "screens": [ { "id": "activity", "export": "Screen", "extensionPoints": ["activity/hud"] } ] }
      """
    And the plugin "hud" with the UI manifest:
      """
      { "client": "client/index.js",
        "contributions": [ { "id": "hud", "extensionPoint": "activity/hud", "export": "Hud",
                             "extensionPoints": ["hud/widget"] } ] }
      """
    And the plugin "widget" contributes "w" to "hud/widget" with order 0
    When the host starts
    Then the contributions to "hud/widget" are in this order:
      | plugin | contribution |
      | widget | w            |
    And the host reported no problems

  Scenario: A contribution to an unknown extension point is left out
    Given the plugin "lonely" contributes "w" to "nowhere/to-plug" with order 0
    And the plugin "bystander" is running
    When the host starts
    Then the host reported an "unknown-extension-point" problem for plugin "lonely" mentioning "nowhere/to-plug"
    And the UI registry contains no contribution from the plugin "lonely"
    And the plugin "lonely" is in the state "started"

  Scenario: Two screens with the same id - the smaller plugin id wins
    Given the plugin "screen-b" with the UI manifest:
      """
      { "client": "client/index.js", "screens": [ { "id": "activity", "export": "B" } ] }
      """
    And the plugin "screen-a" with the UI manifest:
      """
      { "client": "client/index.js", "screens": [ { "id": "activity", "export": "A" } ] }
      """
    When the host starts
    Then the UI registry contains the screen "activity" from the plugin "screen-a"
    And the host reported a "duplicate-screen" problem for plugin "screen-b" mentioning "activity"

  Scenario: Two plugins declaring the same extension point - the smaller plugin id wins
    Given the plugin "hud-b" with the UI manifest:
      """
      { "client": "client/index.js",
        "screens": [ { "id": "b", "export": "B", "extensionPoints": ["shared/point"] } ] }
      """
    And the plugin "hud-a" with the UI manifest:
      """
      { "client": "client/index.js",
        "screens": [ { "id": "a", "export": "A", "extensionPoints": ["shared/point"] } ] }
      """
    When the host starts
    Then the host reported a "duplicate-extension-point" problem for plugin "hud-b" mentioning "shared/point"
    And the extension point "shared/point" is offered by the plugin "hud-a"

  Scenario: A missing client file leaves the plugin's UI out but not the plugin
    Given the plugin "screen-a" with the UI manifest:
      """
      { "client": "client/index.js", "screens": [ { "id": "activity", "export": "Screen" } ] }
      """
    And the client file of "screen-a" does not exist
    When the host starts
    Then the host reported a "client-entry-missing" problem for plugin "screen-a" mentioning "client/index.js"
    And the UI registry contains no screen "activity"
    And the plugin "screen-a" is in the state "started"

  Scenario: A failed plugin contributes nothing
    Given the plugin "screen-a" with the UI manifest:
      """
      { "client": "client/index.js", "screens": [ { "id": "activity", "export": "Screen" } ] }
      """
    And the "start" hook of "screen-a" throws "no display"
    When the host starts
    Then the plugin "screen-a" is in the state "failed"
    And the UI registry contains no screen "activity"

  Scenario: Stopping a plugin removes its contributions and announces the change
    Given the plugin "screen-a" with the UI manifest:
      """
      { "client": "client/index.js",
        "screens": [ { "id": "activity", "export": "Screen", "extensionPoints": ["activity/hud"] } ] }
      """
    And the plugin "widget" contributes "w" to "activity/hud" with order 0
    And the host has started
    When the plugin "widget" is stopped
    Then the contributions to "activity/hud" are in this order:
      | plugin | contribution |
    And a "core.ui-registry.changed" event was published after the plugin stopped

  Scenario: The bridge allow-list is the union of all started UI plugins
    Given the plugin "ui-a" with the UI manifest:
      """
      { "events": { "subscribe": ["metric.power"], "publish": ["activity.start-requested"] } }
      """
    And the plugin "ui-b" with the UI manifest:
      """
      { "events": { "subscribe": ["metric.cadence", "metric.power"], "publish": [] } }
      """
    When the host starts
    Then the UI registry allows subscribing to "metric.cadence, metric.power"
    And the UI registry allows publishing "activity.start-requested"

  Scenario Outline: Invalid UI sections are rejected as invalid manifests (<problem>)
    Given the plugin "broken" with the UI manifest:
      """
      <ui>
      """
    When the host starts
    Then the host reported an "invalid-manifest" problem for the folder "broken" mentioning "<field>"
    And the plugin "broken" is not discovered

    Examples:
      | problem                        | ui                                                                                  | field         |
      | unknown field                  | { "theme": "dark" }                                                                 | theme         |
      | screen without client          | { "screens": [ { "id": "activity", "export": "S" } ] }                              | client        |
      | uppercase screen id            | { "client": "c.js", "screens": [ { "id": "Activity", "export": "S" } ] }            | id            |
      | extension point with a space   | { "client": "c.js", "screens": [ { "id": "a", "export": "S", "extensionPoints": ["a b"] } ] } | extensionPoints |
      | contribution without a target  | { "client": "c.js", "contributions": [ { "id": "w", "export": "W" } ] }             | extensionPoint |
      | client escaping the plugin     | { "client": "../outside.js", "screens": [ { "id": "a", "export": "S" } ] }          | client        |
