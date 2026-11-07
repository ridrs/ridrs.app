@devices @ui
Feature: Device details in the device setup
  A click on a row of the device setup shows that device's details in place of the rows. The
  page is headed by the kind of device and what it is for, not by the setup's heading, with
  whether ridrs looks for devices of the kind at the top right ("Searching…" or "Not searching",
  as the device plugin tells); below, the current device as one card: its icon, its name, its
  link's icon, the signal and, while connected, the battery level of a device that tells it, at the
  top right; below the name its status with the check and its reading, as its row has them. Below that, a tip while something needs the rider (not while it
  reconnects: the status says it all), and the actions. Without a current device there is no
  card, and the devices found follow the heading. Back (or Escape) returns to the rows; Continue
  (or Done) is only offered there. Details have Remove (with a bin icon) while a device is
  connected or tried, which returns to the rows at once, and Connect once it is disconnected.
  After any Connect (or Switch to) the details stay open and show how it goes; they return to the
  rows once the device asked for is connected. Every Connect names the link it uses: "Connect with Bluetooth" (this device's
  Bluetooth) or "Connect with companion". Over the companion, only while ridrs is connected to the
  phone: until then, the devices it found are not listed or counted, and nothing connects
  with the companion.
  When more devices of a kind were found, the row says so, and the details list them below the
  card as rows of their own, the strongest signal first when the details open, so the device next
  to the rider is easy to find among many; while they are open the rows keep their order, and
  devices found meanwhile follow; a click connects one of them instead. Each shows the link that
  sees it: this device's Bluetooth or the companion phone. The same device seen over both links
  (as the device plugin tells) is one box that names it once: on top the row a device of one link
  has, with this device's Bluetooth, and below it a smaller line that offers the companion
  instead; the current device seen over another link offers "Switch to" that link as a button of
  its card, next to Remove, with the link's icon and no signal. Devices
  of one name that are not the same device stay apart. Without a device, a kind names the device connected
  last in this run. While a kind searches, its row counts the devices of the kind found, a
  forgotten one too. Both counts count a device seen over both links once. The companion phone has a row of its own; its details have no Disconnect,
  only Remove (with a bin icon, as a device has it). While the companion is not connected, its
  status shows no warning icon, in its row and in its card.

  Background:
    Given the ridrs plugins "activity-session, metric-power, metric-heart-rate, ui-main-screen, ui-tile-ride-start, ui-activity-screen, ui-devices" together with a test device plugin "test-device"
    And a stand-in "test-bridge" for the companion bridge
    And the host has started
    And the ridrs UI is shown

  Scenario: A click on a connected device shows its details
    Given "test-device" reported its "heart-rate" "HRM-Pro 42" as "connected"
    And I open the device setup from the main screen
    When I open the "Heart Rate Monitor" in the device setup
    Then the details are headed "Heart Rate Monitor", the card "HRM-Pro 42" with the status "Connected"
    And the details card shows the links "Direct"
    And the badge of the details card shows "✓"
    And the page shows no "Link"
    And the page offers a "Remove" button with a bin icon
    And the page offers no "Disconnect" button
    And the page offers no "Done" button
    And the page shows no "Connect Your Devices"

  Scenario: The card shows the reading and the signal of the connected device, as its row does
    Given "test-device" reported its "heart-rate" "HRM-Pro 42" as "connected"
    And "test-device" found the "heart-rate" devices with signals:
      | device     | signal |
      | HRM-Pro 42 | -55    |
    And I open the device setup from the main screen
    And the "heart-rate" measures 72 bpm
    When I open the "Heart Rate Monitor" in the device setup
    Then the details are headed "Heart Rate Monitor", the card "HRM-Pro 42" with the status "72 bpm"
    And the badge of the details card shows "✓"
    And the details card shows the signal "Signal 4 of 4"

  Scenario: The card shows the battery level of the device
    Given "test-device" reported its "heart-rate" "HRM-Pro 42" as "connected"
    And "test-device" reported the battery of its "heart-rate" at 80 %
    And I open the device setup from the main screen
    When I open the "Heart Rate Monitor" in the device setup
    Then the details card shows the battery "Battery 80 %"

  Scenario: A reconnecting device shows neither its last battery level nor a tip
    Given "test-device" reported its "heart-rate" "HRM-Pro 42" as "connected"
    And "test-device" reported the battery of its "heart-rate" at 30 %
    And "test-device" reported its "heart-rate" "HRM-Pro 42" as "reconnecting"
    And I open the device setup from the main screen
    When I open the "Heart Rate Monitor" in the device setup
    Then the details card shows no battery
    And the page shows no "Connection lost; ridrs keeps trying."

  Scenario: A device that tells no battery level shows none
    Given "test-device" reported its "heart-rate" "HRM-Pro 42" as "connected"
    And I open the device setup from the main screen
    When I open the "Heart Rate Monitor" in the device setup
    Then the details card shows no battery

  Scenario: The top right says whether ridrs looks for devices of the kind
    Given "test-device" reported its "heart-rate" "HRM-Pro 42" as "connected"
    And "test-device" looks for "heart-rate" devices over "this device"
    And I open the device setup from the main screen
    When I open the "Heart Rate Monitor" in the device setup
    Then the top right of the details says "Searching…"
    And the status is at the top right of the details
    When "test-device" looks for "heart-rate" devices over no link
    Then the top right of the details says "Not searching"
    And the details are headed "Heart Rate Monitor", the card "HRM-Pro 42" with the status "Connected"

  Scenario: The heart rate monitor's details say a thought on the heart
    Given "test-device" reported its "heart-rate" "HRM-Pro 42" as "connected"
    And I open the device setup from the main screen
    When I open the "Heart Rate Monitor" in the device setup
    Then the details say one of the thoughts on the heart
    And the page shows no "Your heart rate."

  Scenario: Remove asks to forget the device, and closes the details
    Given "test-device" reported its "heart-rate" "HRM-Pro 42" as "connected"
    And I open the device setup from the main screen
    And I open the "Heart Rate Monitor" in the device setup
    When I press "Remove"
    Then the rider asked to forget the "heart-rate"
    And the device details are closed

  Scenario: A kind that searches counts the devices found, a forgotten one too
    Given "test-device" reported its "heart-rate" "HRM-Pro 42" as "connected"
    And "test-device" found the "heart-rate" devices "HRM-Pro 42, Polar H10 A1B2"
    When "test-device" searches for a "heart-rate"
    And "test-device" looks for "heart-rate" devices over "this device"
    And I open the device setup from the main screen
    Then the device setup shows the "Heart Rate Monitor" as "Searching…"
    And the "Heart Rate Monitor" counts 2 devices found
    And the "Heart Rate Monitor" shows no more devices found
    When I open the "Heart Rate Monitor" in the device setup
    Then the details are headed "Heart Rate Monitor"
    And the top right of the details says "Searching…"
    And the details show no card
    And the page offers a "Connect HRM-Pro 42 with Bluetooth" button
    And the page offers a "Connect Polar H10 A1B2 with Bluetooth" button
    And the page offers no "Remove" button

  Scenario: The current device is one card, the devices found follow below it
    Given "test-device" reported its "heart-rate" "HRM-Pro 42" as "connected"
    And "test-device" found the "heart-rate" devices "HRM-Pro 42, Polar H10 A1B2"
    And I open the device setup from the main screen
    When I open the "Heart Rate Monitor" in the device setup
    Then the details card offers a "Remove" button
    And the details card holds no other box
    And the devices found follow the details card as rows
    And the page shows no "Also found"

  Scenario: Without a device, a kind names the device connected last
    Given "test-device" reported its "heart-rate" "HRM-Pro 42" as "connected"
    When "test-device" searches for a "heart-rate"
    And I open the device setup from the main screen
    Then the device setup shows the "Heart Rate Monitor" as "Searching…"
    And the device setup shows:
      | device             | detail                       | status     |
      | Power Meter        | e.g. Assioma, Favero, Stages | Not set up |
      | Smart Trainer      | e.g. Wahoo, Tacx, Elite      | Not set up |
      | Heart Rate Monitor | HRM-Pro 42                   | Searching… |

  Scenario: A disconnected device offers Connect; the details close once it is connected
    Given "test-device" reported its "heart-rate" "HRM-Pro 42" as "disconnected"
    And I open the device setup from the main screen
    And I open the "Heart Rate Monitor" in the device setup
    When I press "Connect with Bluetooth"
    Then the rider asked to connect the "heart-rate" "heart-rate-1"
    And the device details stay open
    When "test-device" reports its "heart-rate" "HRM-Pro 42" as "connecting"
    Then the device details stay open
    When "test-device" reports its "heart-rate" "HRM-Pro 42" as "connected"
    Then the device details are closed

  Scenario: A connection that does not come keeps the details open
    Given "test-device" reported its "heart-rate" "HRM-Pro 42" as "disconnected"
    And I open the device setup from the main screen
    And I open the "Heart Rate Monitor" in the device setup
    When I press "Connect with Bluetooth"
    And "test-device" reports its "heart-rate" "HRM-Pro 42" as "reconnecting"
    Then the device details stay open
    And the details are headed "Heart Rate Monitor", the card "HRM-Pro 42" with the status "Reconnecting…"

  Scenario: A disconnected device of the companion offers Connect with companion
    Given the companion bridge reports "connected" to "Pixel 8"
    And "test-device" reported its "heart-rate" "HRM-Pro 42" as "disconnected" through the "companion"
    And I open the device setup from the main screen
    When I open the "Heart Rate Monitor" in the device setup
    Then the page offers a "Connect with companion" button
    And the page offers no "Connect with Bluetooth" button

  Scenario: Without the phone, a disconnected device of the companion offers no Connect
    Given the companion bridge reports "reconnecting" to "Pixel 8"
    And "test-device" reported its "heart-rate" "HRM-Pro 42" as "disconnected" through the "companion"
    And I open the device setup from the main screen
    When I open the "Heart Rate Monitor" in the device setup
    Then the page offers no "Connect with companion" button
    And the page offers no "Connect with Bluetooth" button

  Scenario: Without the phone, the devices the companion found are not offered
    Given the companion bridge reports "reconnecting" to "Pixel 8"
    And "test-device" reported its "heart-rate" "HRM-Pro 42" as "connected"
    And "test-device" found the "heart-rate" devices over the links:
      | device                    | links                  |
      | HRM-Pro 42                | this device, companion |
      | Polar H10 A1B2            | this device            |
      | Xiaomi Smart Band 10 6014 | this device, companion |
      | Wahoo HRM                 | companion              |
    When I open the device setup from the main screen
    Then the "Heart Rate Monitor" shows that 2 more devices were found
    When I open the "Heart Rate Monitor" in the device setup
    Then the devices found show their links:
      | device                    | links  |
      | Polar H10 A1B2            | Direct |
      | Xiaomi Smart Band 10 6014 | Direct |
    And the page offers no "Connect with companion" button
    And the page offers no "Connect Xiaomi Smart Band 10 6014 with companion" button
    And the page offers no "Connect Wahoo HRM with companion" button

  Scenario: A kind that searches counts no device of the companion without the phone
    Given the companion bridge reports "unreachable" to "Pixel 8"
    And "test-device" found the "heart-rate" devices over the links:
      | device         | links       |
      | Polar H10 A1B2 | this device |
      | Wahoo HRM      | companion   |
    When "test-device" searches for a "heart-rate"
    And I open the device setup from the main screen
    Then the "Heart Rate Monitor" counts 1 devices found

  Scenario: The power meter shows the details of the trainer that measures the power
    Given "test-device" reported its "trainer" "KICKR CORE 1234" as "connected"
    And I open the device setup from the main screen
    When I open the "Power Meter" in the device setup
    Then the details are headed "Power Meter", the card "KICKR CORE 1234" with the status "Connected"
    And the details card shows the links "Direct"

  Scenario: More devices found show in the row, and the rider can connect one of them
    Given "test-device" reported its "heart-rate" "HRM-Pro 42" as "connected"
    And "test-device" found the "heart-rate" devices "HRM-Pro 42, Polar H10 A1B2"
    When I open the device setup from the main screen
    Then the "Heart Rate Monitor" shows that 1 more device was found
    When I open the "Heart Rate Monitor" in the device setup
    And I press "Connect Polar H10 A1B2 with Bluetooth"
    Then the rider asked to connect the "heart-rate" "heart-rate-2"
    And the device details stay open
    When "test-device" reports its "heart-rate" "Polar H10 A1B2" with the id "heart-rate-2" as "connected"
    Then the device details are closed

  Scenario: A device seen over both links counts once among the devices found
    Given the companion bridge reports "connected" to "Pixel 8"
    And "test-device" reported its "heart-rate" "HRM-Pro 42" as "connected"
    And "test-device" found the "heart-rate" devices over the links:
      | device                    | links                  |
      | HRM-Pro 42                | this device, companion |
      | Xiaomi Smart Band 10 6014 | companion, this device |
    When I open the device setup from the main screen
    Then the "Heart Rate Monitor" shows that 1 more device was found

  Scenario: A kind that searches counts a device seen over both links once
    Given the companion bridge reports "connected" to "Pixel 8"
    And "test-device" reported its "heart-rate" "HRM-Pro 42" as "connected"
    And "test-device" found the "heart-rate" devices over the links:
      | device                    | links                  |
      | HRM-Pro 42                | this device            |
      | Xiaomi Smart Band 10 6014 | companion, this device |
    When "test-device" searches for a "heart-rate"
    And I open the device setup from the main screen
    Then the "Heart Rate Monitor" counts 2 devices found

  Scenario: The devices found are listed by signal strength, the strongest first
    Given "test-device" reported its "trainer" "KICKR CORE 1234" as "connected"
    And "test-device" found the "trainer" devices with signals:
      | device          | signal |
      | KICKR CORE 1234 | -50    |
      | Tacx Neo 2T 77  | -82    |
      | KICKR CORE 5678 | -47    |
      | Elite Direto 9  |        |
    And I open the device setup from the main screen
    When I open the "Smart Trainer" in the device setup
    Then the devices found are listed as:
      | device          | signal        |
      | KICKR CORE 5678 | Signal 4 of 4 |
      | Tacx Neo 2T 77  | Signal 1 of 4 |
      | Elite Direto 9  |               |
    And the devices found show no dBm

  Scenario: A device connected through the companion names its link in the details
    Given "test-device" reported its "trainer" "KICKR CORE 1234" as "connected" through the "companion"
    When I open the device setup from the main screen
    Then the device setup shows:
      | device             | detail                          | status     |
      | Power Meter        | KICKR CORE 1234                 | Connected  |
      | Smart Trainer      | KICKR CORE 1234                 | Connected  |
      | Heart Rate Monitor | e.g. Polar, Garmin, Apple Watch | Not set up |
    When I open the "Smart Trainer" in the device setup
    Then the details card shows the links "Companion"

  Scenario: The devices found keep their order while the details are open
    Given "test-device" reported its "trainer" "KICKR CORE 1234" as "connected"
    And "test-device" found the "trainer" devices with signals:
      | device          | signal |
      | KICKR CORE 1234 | -50    |
      | Tacx Neo 2T 77  | -82    |
      | KICKR CORE 5678 | -47    |
    And I open the device setup from the main screen
    And I open the "Smart Trainer" in the device setup
    When "test-device" found the "trainer" devices with signals:
      | device          | signal |
      | KICKR CORE 1234 | -50    |
      | Tacx Neo 2T 77  | -45    |
      | KICKR CORE 5678 | -75    |
      | Elite Direto 9  | -40    |
    Then the devices found are listed as:
      | device          | signal        |
      | KICKR CORE 5678 | Signal 2 of 4 |
      | Tacx Neo 2T 77  | Signal 4 of 4 |
      | Elite Direto 9  | Signal 4 of 4 |

  Scenario: Each device found shows the link that sees it
    Given the companion bridge reports "connected" to "Pixel 8"
    And "test-device" reported its "heart-rate" "HRM-Pro 42" as "connected"
    And "test-device" found the "heart-rate" devices over the links:
      | device                    | links                  |
      | HRM-Pro 42                | this device            |
      | Polar H10 A1B2            | this device            |
      | Xiaomi Smart Band 10 6014 | this device, companion |
    And I open the device setup from the main screen
    When I open the "Heart Rate Monitor" in the device setup
    Then the devices found show their links:
      | device                    | links             |
      | Polar H10 A1B2            | Direct            |
      | Xiaomi Smart Band 10 6014 | Direct, Companion |
    And the page names "Xiaomi Smart Band 10 6014" once
    And the page offers a "Connect Xiaomi Smart Band 10 6014 with Bluetooth" button
    And the page offers a "Connect Xiaomi Smart Band 10 6014 with companion" button
    When I press "Connect Xiaomi Smart Band 10 6014 with companion"
    Then the rider asked to connect the "heart-rate" "heart-rate-4"

  Scenario: A device seen over both links leads with Bluetooth, the companion below
    Given the companion bridge reports "connected" to "Pixel 8"
    And "test-device" reported its "heart-rate" "HRM-Pro 42" as "connected"
    And "test-device" found the "heart-rate" devices over the links:
      | device                    | links                  |
      | HRM-Pro 42                | this device            |
      | Xiaomi Smart Band 10 6014 | companion, this device |
    And I open the device setup from the main screen
    When I open the "Heart Rate Monitor" in the device setup
    Then the box of "Xiaomi Smart Band 10 6014" shows the lines:
      | line                                             | named |
      | Xiaomi Smart Band 10 6014 Connect with Bluetooth | yes   |
      | or connect with companion                        | no    |
    And the devices found show their links:
      | device                    | links             |
      | Xiaomi Smart Band 10 6014 | Direct, Companion |
    When I press "Connect Xiaomi Smart Band 10 6014 with Bluetooth"
    Then the rider asked to connect the "heart-rate" "heart-rate-3"

  Scenario: Devices of one name that are not the same device stay apart
    Given the companion bridge reports "connected" to "Pixel 8"
    And "test-device" reported its "heart-rate" "HRM-Pro 42" as "connected"
    And "test-device" found the "heart-rate" devices over the links:
      | device     | links       |
      | HRM-Pro 42 | this device |
      | Wahoo HRM  | this device |
      | Wahoo HRM  | companion   |
    And I open the device setup from the main screen
    When I open the "Heart Rate Monitor" in the device setup
    Then the devices found show their links:
      | device    | links     |
      | Wahoo HRM | Direct    |
      | Wahoo HRM | Companion |

  Scenario: The current device seen over another link offers that link next to Remove
    Given the companion bridge reports "connected" to "Pixel 8"
    And "test-device" reported its "heart-rate" "HRM-Pro 42" as "connected"
    And "test-device" found the "heart-rate" devices over the links:
      | device         | links                  | signals  |
      | HRM-Pro 42     | this device, companion | -55, -75 |
      | Polar H10 A1B2 | this device            |          |
    And I open the device setup from the main screen
    When I open the "Heart Rate Monitor" in the device setup
    Then the details card offers the buttons "Remove, Switch to companion" side by side
    And the "Switch to companion" button shows the link "Companion" and no signal
    And the details card holds no other box
    And the page names "HRM-Pro 42" once
    And the devices found show their links:
      | device         | links  |
      | Polar H10 A1B2 | Direct |
    When I press "Switch to companion"
    Then the rider asked to connect the "heart-rate" "heart-rate-2"
    And the device details stay open
    When "test-device" reports its "heart-rate" "HRM-Pro 42" with the id "heart-rate-2" as "connected"
    Then the device details are closed

  Scenario: Back returns to the rows
    Given "test-device" reported its "trainer" "KICKR CORE 1234" as "connected"
    And I open the device setup from the main screen
    And I open the "Smart Trainer" in the device setup
    When I press "Back"
    Then the device details are closed
    And the device setup shows the "Smart Trainer" as "Connected"
    And the page offers a "Done" button

  Scenario: Escape returns to the rows
    Given "test-device" reported its "trainer" "KICKR CORE 1234" as "connected"
    And I open the device setup from the main screen
    And I open the "Smart Trainer" in the device setup
    When I press Escape
    Then the device details are closed

  Scenario: A kind that searches without a device shows no card, only whether ridrs looks
    Given "test-device" searches for a "heart-rate"
    And "test-device" looks for "heart-rate" devices over "this device, companion"
    And I open the device setup from the main screen
    When I open the "Heart Rate Monitor" in the device setup
    Then the details are headed "Heart Rate Monitor"
    And the top right of the details says "Searching…"
    And the status is at the top right of the details
    And the details show no card
    And the page shows no "Wake the device and keep it close."

  Scenario: The companion has a row of its own
    Given the companion bridge reports "unpaired"
    When I open the device setup from the main screen
    Then the device setup shows:
      | device             | detail                          | status        |
      | Power Meter        | e.g. Assioma, Favero, Stages    | Not set up    |
      | Smart Trainer      | e.g. Wahoo, Tacx, Elite         | Not set up    |
      | Heart Rate Monitor | e.g. Polar, Garmin, Apple Watch | Not set up    |
      | Companion App      | Phone with the ridrs companion  | Not connected |

  Scenario: A connected companion shows its details, without Disconnect
    Given the companion bridge reports "connected" to "Pixel 8"
    And I open the device setup from the main screen
    When I open the "Companion App" in the device setup
    Then the details are headed "Companion App", the card "Pixel 8" with the status "Connected"
    And the page offers a "Remove" button with a bin icon
    And the page offers no "Forget companion" button
    And the page offers no "Disconnect" button

  Scenario: A disconnected companion offers Connect
    Given the companion bridge reports "disconnected" to "Pixel 8"
    And I open the device setup from the main screen
    And I open the "Companion App" in the device setup
    When I press "Connect"
    Then the rider asked to connect the companion
    And the device details stay open
    When the companion bridge reports "connected" to "Pixel 8"
    Then the device details are closed

  Scenario: A companion out of reach gives a tip
    Given the companion bridge reports "unreachable" to "Pixel 8"
    And I open the device setup from the main screen
    When I open the "Companion App" in the device setup
    Then the details are headed "Companion App", the card "Pixel 8" with the status "Not reachable"
    And the details give the tip "Open the companion app and keep the screen on."
    And the page offers a "Try again" button

  Scenario: A companion that is not connected shows no warning icon
    Given the companion bridge reports "unreachable" to "Pixel 8"
    When I open the device setup from the main screen
    Then the device setup shows the "Companion App" as "Not reachable"
    And the status of the "Companion App" shows no icon
    When I open the "Companion App" in the device setup
    Then the details are headed "Companion App", the card "Pixel 8" with the status "Not reachable"
    And the status of the details card shows no icon
