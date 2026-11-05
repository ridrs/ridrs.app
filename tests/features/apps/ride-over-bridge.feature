@phase-3b @e2e @ui
Feature: Ride with the trainer connected to a companion
  The native app's composition root with all real plugins; a fixture connector puts a simulated
  companion "Pixel 8" (code 482913) with a trainer into the network. This device's Bluetooth
  and the companion run at once: there is no transport to switch. The companion is paired in
  its row of the device setup.

  Background:
    Given the plugin "bridge-connector-tauri" is disabled
    And the plugin "transport-ble-tauri" is disabled
    And the plugin "transport-ble-noble" is disabled

  Scenario: Pair, then ride
    Given the plugin directories "plugins, tests/fixtures/plugins/simulated-companion"
    When I start the ridrs app with these options
    And I open the device indicator
    And I open the "Companion App" in the device setup
    Then the pairing offers "Scan the QR code" or "Enter the code"
    And a pairing QR code is shown
    And the companion "Pixel 8" is offered for pairing
    And the code field of "Pixel 8" takes 6 digits
    And there is no field for a companion address
    And the page offers no "Pair" button
    When I enter the pairing code "482913" for "Pixel 8"
    Then the companion is shown as connected to "Pixel 8"
    When I press "Back"
    And I press "Continue"
    And I press "Start ride"
    Then the power widget shows "220" "W"
    And the cadence widget shows "92" "rpm"
    When I close the ridrs app
    Then the app reported no lifecycle problems

  Scenario: This device's Bluetooth and the companion at once
    Given the plugin directories "plugins, tests/fixtures/plugins/simulated-trainer, tests/fixtures/plugins/simulated-companion"
    When I start the ridrs app with these options
    And I open the device indicator
    And I open the "Companion App" in the device setup
    And I enter the pairing code "482913" for "Pixel 8"
    Then the companion is shown as connected to "Pixel 8"
    When I press "Back"
    Then the device setup shows the "Smart Trainer" as "Connected"
    When I open the "Smart Trainer" in the device setup
    Then the details are headed "Smart Trainer", the card "SIM KICKR" with the status "Connected"
    And the details card shows the links "Direct"
    And the top right of the details says "Searching…"
    When I close the ridrs app
    Then the app reported no lifecycle problems

  Scenario: Forgetting the companion shows the pairing again
    Given the plugin directories "plugins, tests/fixtures/plugins/simulated-companion"
    When I start the ridrs app with these options
    And I open the device indicator
    And I open the "Companion App" in the device setup
    And I enter the pairing code "482913" for "Pixel 8"
    Then the companion is shown as connected to "Pixel 8"
    And the page offers no "Disconnect" button
    When I press "Remove"
    Then a pairing QR code is shown
    When I close the ridrs app
    Then the app reported no lifecycle problems
