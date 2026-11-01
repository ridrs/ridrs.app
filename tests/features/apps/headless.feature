@phase-1 @e2e
Feature: Headless ridrs application
  The headless app is the first composition root: it discovers plugins
  from a directory, starts them and shuts down gracefully.

  Scenario: The example plugins play ping-pong through the real plugin host
    Given the plugin directory "tests/fixtures/plugins/ping-pong"
    When I start the headless app with that plugin directory
    And the app has logged "host started"
    And I send the app an interrupt signal
    Then the app logged that the plugins "example-ping, example-pong" were started
    And the app logged "example-pong received ping" before "example-ping received pong"
    And the app logged "host stopped"
    And the app exited with code 0

  Scenario: The headless app reports broken plugins and keeps running healthy ones
    Given the plugin directory "tests/fixtures/plugins/with-broken-plugin"
    When I start the headless app with that plugin directory
    And the app has logged "host started"
    And I send the app an interrupt signal
    Then the app logged an "invalid-manifest" problem
    And the app logged that the plugins "example-ping" were started
    And the app exited with code 0
