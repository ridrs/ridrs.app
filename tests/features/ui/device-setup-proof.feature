@devices @ui
Feature: The device setup shows the controller once found, and proof of every device
  A controller is optional gear: its row appears in the device setup only once a controller
  was found, and never counts against "Everything is connected" before that. While a device
  is connected its status proves that it works: the watts of the power meter and the heart
  rate take the place of "Connected", and held controller buttons take the place of the
  check. A reading proves the device only while it is fresh: once the device falls silent, as a
  band whose heart rate was switched off, the row says "Connected" again.

  Background:
    Given the ridrs plugins "activity-session, device-registry, metric-power, metric-heart-rate, ui-main-screen, ui-tile-ride-start, ui-activity-screen, ui-devices" together with a test device plugin "test-device"
    And the host has started
    And the ridrs UI is shown

  Scenario: A controller that is still searched for is not shown
    Given "test-device" searches for a "controller"
    When I open the device setup from the main screen
    Then the device setup shows:
      | device             | detail                          | status     |
      | Power Meter        | e.g. Assioma, Favero, Stages    | Not set up |
      | Smart Trainer      | e.g. Wahoo, Tacx, Elite         | Not set up |
      | Heart Rate Monitor | e.g. Polar, Garmin, Apple Watch | Not set up |

  Scenario: A found controller pops up in the device setup
    Given I open the device setup from the main screen
    And "test-device" searches for a "controller"
    When "test-device" reports its "controller" "Zwift Ride" as "connecting"
    Then the device setup shows:
      | device             | detail                          | status      |
      | Power Meter        | e.g. Assioma, Favero, Stages    | Not set up  |
      | Smart Trainer      | e.g. Wahoo, Tacx, Elite         | Not set up  |
      | Heart Rate Monitor | e.g. Polar, Garmin, Apple Watch | Not set up  |
      | Controller         | Zwift Ride                      | Connecting… |

  Scenario: A found controller stays while it reconnects
    Given "test-device" reported its "controller" "Zwift Ride" as "reconnecting"
    When I open the device setup from the main screen
    Then the device setup shows the "Controller" as "Reconnecting…"

  Scenario: A controller that is not found does not hold up "Everything is connected"
    Given "test-device" reported its "trainer" "KICKR CORE 1234" as "connected"
    And "test-device" reported its "heart-rate" "HRM-Pro 42" as "connected"
    And "test-device" searches for a "controller"
    When I open the device setup from the main screen
    Then the device setup says "Everything is connected."

  Scenario: The devices tile keeps its three rows
    When "test-device" reports its "controller" "Zwift Ride" as "connected"
    And "test-device" reports its "trainer" "KICKR CORE 1234" as "connected"
    Then the devices tile shows:
      | device     | state     |
      | Trainer    | connected |
      | Power      | connected |
      | Heart rate | none      |

  Scenario: Connected devices prove that they work in their status
    Given "test-device" reported its "trainer" "KICKR CORE 1234" as "connected"
    And "test-device" reported its "heart-rate" "HRM-Pro 42" as "connected"
    And "test-device" reported its "controller" "Zwift Ride" as "connected"
    And I open the device setup from the main screen
    When the "trainer" measures 220 W
    And the "heart-rate" measures 72 bpm
    Then the device setup shows:
      | device             | detail          | status    |
      | Power Meter        | KICKR CORE 1234 | 220 W     |
      | Smart Trainer      | KICKR CORE 1234 | Connected |
      | Heart Rate Monitor | HRM-Pro 42      | 72 bpm    |
      | Controller         | Zwift Ride      | Connected |
    And the badge of the "Power Meter" shows "✓"
    And the badge of the "Heart Rate Monitor" shows "✓"

  Scenario: The power follows the power meter
    Given "test-device" reported its "trainer" "KICKR CORE 1234" as "connected"
    And I open the device setup from the main screen
    When the "trainer" measures 220 W
    And the "trainer" measures 245 W
    Then the device setup shows the "Power Meter" as "245 W"

  Scenario: A held controller button takes the place of the check
    Given "test-device" reported its "controller" "Zwift Ride" as "connected"
    And I open the device setup from the main screen
    When the "controller" holds down "a, shift-up-right"
    Then the badge of the "Controller" shows "A, Right shift up"
    When the "controller" holds down ""
    Then the badge of the "Controller" shows "✓"

  Scenario: The buttons of both controllers show together
    Given "test-device" reported its "controller" "Zwift Ride" as "connected"
    And I open the device setup from the main screen
    And the device setup shows the "Controller" as "Connected"
    When the "controller" holds down "left"
    And the other "controller" of the pair holds down "a"
    Then the badge of the "Controller" shows "D-pad left, A"

  Scenario: Every controller button has a symbol of its own
    Given "test-device" reported its "controller" "Zwift Ride" as "connected"
    And I open the device setup from the main screen
    When the "controller" holds down "left, up, right, down, a, b, y, z, shift-up-left, shift-down-left, power-up-left, on-off-left, shift-up-right, shift-down-right, power-up-right, on-off-right"
    Then the badge of the "Controller" shows the symbols "← ↑ → ↓ A B Y Z + − ⚡ ⏻ + − ⚡ ⏻"
    And the badge of the "Controller" shows "D-pad left, D-pad up, D-pad right, D-pad down, A, B, Y, Z, Left shift up, Left shift down, Left power-up, Left on/off, Right shift up, Right shift down, Right power-up, Right on/off"
    And the badge of the "Controller" draws "D-pad left, D-pad up, D-pad right, D-pad down, Left power-up, Right power-up" as icons

  Scenario: A device that is not connected proves nothing
    Given "test-device" reported its "heart-rate" "HRM-Pro 42" as "connected"
    And I open the device setup from the main screen
    And the "heart-rate" measures 72 bpm
    When "test-device" reports its "heart-rate" "HRM-Pro 42" as "reconnecting"
    Then the device setup shows the "Heart Rate Monitor" as "Reconnecting…"

  @fake-timers
  Scenario: A device that falls silent proves nothing any more
    Given "test-device" reported its "heart-rate" "HRM-Pro 42" as "connected"
    And I open the device setup from the main screen
    And the "heart-rate" measures 72 bpm
    And the device setup shows the "Heart Rate Monitor" as "72 bpm"
    When 5 seconds pass
    Then the device setup shows the "Heart Rate Monitor" as "Connected"

  Scenario: Only the shown device proves the row
    Given "test-device" reported its "heart-rate" "HRM-Pro 42" as "connected"
    And I open the device setup from the main screen
    When another heart-rate sensor measures 150 bpm
    Then the device setup shows the "Heart Rate Monitor" as "Connected"
