@phase-3b @e2e @ui
Feature: Ride with the trainer connected to a companion
  The native app's composition root with all real plugins, switched to the companion bridge; a
  fixture connector puts a simulated companion "Pixel 8" (code 482913) with a trainer into the network.

  Scenario: Pair, then ride
    Given the plugin directories "plugins, tests/fixtures/plugins/simulated-companion"
    And the plugin "bridge-connector-tauri" is disabled
    And the ridrs app uses the companion bridge
    When I start the ridrs app with these options
    Then a pairing QR code is shown
    And the companion "Pixel 8" is offered for pairing
    And there is no field for a companion address
    When I enter the pairing code "482913" for "Pixel 8"
    Then the companion is shown as connected to "Pixel 8"
    When I press "Start ride"
    Then the power widget shows "220" "W"
    And the cadence widget shows "92" "rpm"
    When I close the ridrs app
    Then the app reported no lifecycle problems

  Scenario: Switching to the companion is the rider's choice
    Given the plugin directories "plugins"
    And the plugin "transport-ble-noble" is disabled
    When I start the ridrs app with these options
    And I press "Use a companion phone"
    Then the app was asked to use the "bridge" transport
    When I close the ridrs app
    Then the app reported no lifecycle problems

  Scenario: Disconnecting and connecting again from ridrs
    Given the plugin directories "plugins, tests/fixtures/plugins/simulated-companion"
    And the plugin "bridge-connector-tauri" is disabled
    And the ridrs app uses the companion bridge
    When I start the ridrs app with these options
    And I enter the pairing code "482913" for "Pixel 8"
    Then the companion is shown as connected to "Pixel 8"
    When I press "Disconnect"
    Then the companion status reads "Disconnected from Pixel 8 (by ridrs)"
    When I press "Connect"
    Then the companion is shown as connected to "Pixel 8"
    When I press "Forget companion"
    Then a pairing QR code is shown
    When I close the ridrs app
    Then the app reported no lifecycle problems
