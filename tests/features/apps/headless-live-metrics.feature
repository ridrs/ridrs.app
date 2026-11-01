@phase-2 @e2e
Feature: Live power and cadence in the headless app
  The headless app composes real plugins with a simulated trainer and shows
  live values - and honest "unavailable" values while the trainer is gone.

  Scenario: The console follows a simulated trainer through a connection loss
    Given the plugin directories "plugins, tests/fixtures/plugins/simulated-trainer"
    And the plugin "transport-ble-noble" is disabled
    When I start the headless app with these options
    And the app has logged a live line with power 200 and cadence 90
    And the app has logged a live line with power unavailable because of "disconnected"
    And the app has logged a live line with power 220 and cadence 92
    And I send the app an interrupt signal
    Then the app logged the connection states "searching, connecting, connected, reconnecting, connected, disconnected" for "SIM KICKR"
    And the app logged no live line with power 0 while the trainer was disconnected
    And the app logged "host stopped"
    And the app exited with code 0

  Scenario: A missing Bluetooth stack does not crash the app
    Given the plugin directories "plugins"
    And the BLE transport cannot be loaded
    When I start the headless app with these options
    And the app has logged "host started"
    And I send the app an interrupt signal
    Then the app logged an "entry-load-failure" problem for plugin "transport-ble-noble"
    And the app logged that the plugin "device-ftms-trainer" is "blocked"
    And the app logged a live line with power unavailable because of "no-source"
    And the app exited with code 0
