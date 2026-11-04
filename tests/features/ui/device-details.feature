@devices @ui
Feature: Device details in the device setup
  A click on a row of the device setup shows that device's details on a short card in place of
  the rows. The header names the device and its status; below it, only what the header does
  not say (the link, the device behind the power) and a tip while something needs the rider.
  Back (or Escape) returns to the rows; Continue (or Done) is only offered there. Details have
  Disconnect while a device is connected and Connect once it is disconnected; both return to
  the rows as well. When more devices of a kind were found, the row says so, and the details
  offer to connect one of them instead. When the device is connected over both links, the
  rider chooses whose data is used. The companion phone has a row of its own; its details have
  no Disconnect, only Forget companion.

  Background:
    Given the ridrs plugins "activity-session, device-registry, ui-main-screen, ui-activity-screen, ui-devices" together with a test device plugin "test-device"
    And the host has started
    And the ridrs UI is shown

  Scenario: A click on a connected device shows its details
    Given "test-device" reported its "heart-rate" "HRM-Pro 42" as "connected"
    And I open the device indicator
    When I open the "Heart Rate Monitor" in the device setup
    Then the details card is headed "Heart Rate Monitor" "HRM-Pro 42" with the status "Connected"
    And the device details show:
      | Link | Direct |
    And the page offers a "Disconnect" button
    And the page offers no "Done" button

  Scenario: Disconnect asks to disconnect the device, and closes the details
    Given "test-device" reported its "heart-rate" "HRM-Pro 42" as "connected"
    And I open the device indicator
    And I open the "Heart Rate Monitor" in the device setup
    When I press "Disconnect"
    Then the rider asked to disconnect the "heart-rate"
    And the device details are closed

  Scenario: A disconnected device offers Connect, which closes the details
    Given "test-device" reported its "heart-rate" "HRM-Pro 42" as "disconnected"
    And I open the device indicator
    And I open the "Heart Rate Monitor" in the device setup
    When I press "Connect"
    Then the rider asked to connect the "heart-rate" "heart-rate-1"
    And the device details are closed

  Scenario: The power meter shows the details of the trainer that measures the power
    Given "test-device" reported its "trainer" "KICKR CORE 1234" as "connected"
    And I open the device indicator
    When I open the "Power Meter" in the device setup
    Then the details card is headed "Power Meter" "KICKR CORE 1234" with the status "Connected"
    And the device details show:
      | Source | Smart Trainer |
      | Link   | Direct        |

  Scenario: More devices found show in the row, and the rider can connect one of them
    Given "test-device" reported its "heart-rate" "HRM-Pro 42" as "connected"
    And "test-device" found the "heart-rate" devices "HRM-Pro 42, Polar H10 A1B2"
    When I open the device indicator
    Then the "Heart Rate Monitor" shows that 1 more device was found
    When I open the "Heart Rate Monitor" in the device setup
    And I press "Connect Polar H10 A1B2"
    Then the rider asked to connect the "heart-rate" "heart-rate-2"
    And the device details are closed

  Scenario: A device connected through the companion names its link in the details
    Given "test-device" reported its "trainer" "KICKR CORE 1234" as "connected" through the "companion"
    When I open the device indicator
    Then the device setup shows:
      | device             | detail                          | status     |
      | Power Meter        | KICKR CORE 1234                 | Connected  |
      | Smart Trainer      | KICKR CORE 1234                 | Connected  |
      | Heart Rate Monitor | e.g. Polar, Garmin, Apple Watch | Not set up |
    When I open the "Smart Trainer" in the device setup
    Then the device details show:
      | Link | Companion |

  Scenario: Connected over both links, the rider chooses whose data is used
    Given "test-device" reported its "trainer" "KICKR CORE 1234" as "connected" over both links
    And I open the device indicator
    And I open the "Smart Trainer" in the device setup
    When I choose the link "Companion"
    Then the rider asked to use the "trainer" data of the "companion"

  Scenario: Connected over one link only, there is no choice of link
    Given the companion bridge reports "connected" to "Pixel 8"
    And "test-device" reported its "trainer" "KICKR CORE 1234" as "connected"
    And I open the device indicator
    When I open the "Smart Trainer" in the device setup
    Then there is no choice of link

  Scenario: Back returns to the rows
    Given "test-device" reported its "trainer" "KICKR CORE 1234" as "connected"
    And I open the device indicator
    And I open the "Smart Trainer" in the device setup
    When I press "Back"
    Then the device details are closed
    And the device setup shows the "Smart Trainer" as "Connected"
    And the page offers a "Done" button

  Scenario: Escape returns to the rows
    Given "test-device" reported its "trainer" "KICKR CORE 1234" as "connected"
    And I open the device indicator
    And I open the "Smart Trainer" in the device setup
    When I press Escape
    Then the device details are closed

  Scenario: A device that is searched for gives a tip
    Given "test-device" searches for a "heart-rate"
    And I open the device indicator
    When I open the "Heart Rate Monitor" in the device setup
    Then the details card is headed "Heart Rate Monitor" "e.g. Polar, Garmin, Apple Watch" with the status "Searching…"
    And the details give the tip "Wake the device and keep it close."

  Scenario: The companion has a row of its own
    Given the companion bridge reports "unpaired"
    When I open the device indicator
    Then the device setup shows:
      | device             | detail                          | status        |
      | Power Meter        | e.g. Assioma, Favero, Stages    | Not set up    |
      | Smart Trainer      | e.g. Wahoo, Tacx, Elite         | Not set up    |
      | Heart Rate Monitor | e.g. Polar, Garmin, Apple Watch | Not set up    |
      | Companion App      | Phone with the ridrs companion  | Not connected |

  Scenario: A connected companion shows its details, without Disconnect
    Given the companion bridge reports "connected" to "Pixel 8"
    And I open the device indicator
    When I open the "Companion App" in the device setup
    Then the details card is headed "Companion App" "Pixel 8" with the status "Connected"
    And the page offers a "Forget companion" button
    And the page offers no "Disconnect" button

  Scenario: A disconnected companion offers Connect
    Given the companion bridge reports "disconnected" to "Pixel 8"
    And I open the device indicator
    And I open the "Companion App" in the device setup
    When I press "Connect"
    Then the rider asked to connect the companion
    And the device details are closed

  Scenario: A companion out of reach gives a tip
    Given the companion bridge reports "unreachable" to "Pixel 8"
    And I open the device indicator
    When I open the "Companion App" in the device setup
    Then the details card is headed "Companion App" "Pixel 8" with the status "Not reachable"
    And the details give the tip "Open the companion app and keep the screen on."
    And the page offers a "Try again" button
