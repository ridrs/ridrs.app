@devices @fake-timers
Feature: The Zwift Ride over every BLE transport
  The controller only sends its buttons after it was greeted on its control point, so a BLE
  connection can write as well as listen. The unchanged Zwift Ride plugin greets it over the
  Tauri transport and over the companion bridge alike.

  Scenario: The controller is greeted over the Tauri transport
    Given a simulated Tauri bridge with a Zwift Ride "Zwift Ride"
    And the ridrs plugins "transport-ble-tauri, device-zwift-ride" running
    And the controller "Zwift Ride" is connected
    Then the controller "Zwift Ride" received "RideOn" 1 time
    When the controller sends the keypad packet "23 08 ef ff ff ff 0f"
    Then the buttons held down are "a"

  Scenario: The controller is greeted over the companion bridge
    Given the host clock shows "10:00:00.000"
    And a companion "Pixel 8" wrapping a simulated BLE environment with a Zwift Ride "Zwift Ride"
    And the companion shows the pairing code "482913"
    And ridrs is paired with the companion
    And the ridrs plugins "transport-ble-bridge, device-zwift-ride" running over the simulated network
    And the controller "Zwift Ride" is connected
    Then the controller "Zwift Ride" received "RideOn" 1 time
    When the controller sends the keypad packet "23 08 ef ff ff ff 0f"
    Then the buttons held down are "a"

