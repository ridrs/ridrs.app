@phase-3b @fake-timers
Feature: Finding and pairing a companion
  transport-ble-bridge lists the companions announced in the network. The rider pairs one of them
  by scanning the QR code ridrs shows with the phone, or by entering the code the phone shows.
  The pairing is kept, so the next start needs neither.

  Background:
    Given the host clock shows "10:00:00.000"
    And a companion "Pixel 8" wrapping a simulated BLE environment with an FTMS trainer "KICKR CORE 1234"
    And the companion shows the pairing code "482913"

  Scenario: Announced companions are listed
    When the ridrs plugins "transport-ble-bridge" are running over the simulated network
    Then the listed companions are "Pixel 8"
    And the bridge state is "unpaired"

  Scenario: Pairing with the code shown on the phone
    Given the ridrs plugins "transport-ble-bridge" are running over the simulated network
    When ridrs asks to pair with "Pixel 8" using the code "482913"
    Then the bridge state is "connected"
    And the listed companion "Pixel 8" is paired
    And the pairing with "Pixel 8" is stored

  Scenario: A wrong code is reported and nothing is stored
    Given the ridrs plugins "transport-ble-bridge" are running over the simulated network
    When ridrs asks to pair with "Pixel 8" using the code "111111"
    Then the bridge state is "rejected" with the reason "bad-code"
    And the host reported a "bridge-rejected" problem for plugin "transport-ble-bridge"
    And no pairing is stored

  Scenario: Pairing by scanning the QR code ridrs shows
    Given the ridrs plugins "transport-ble-bridge" are running over the simulated network
    And ridrs offers a pairing QR code
    When the companion scans the pairing QR code
    And 2 seconds pass
    Then the bridge state is "connected"
    And the pairing with "Pixel 8" is stored

  Scenario: Without a scan, ridrs does not pair and does not lock the code out
    Given the ridrs plugins "transport-ble-bridge" are running over the simulated network
    And ridrs offers a pairing QR code
    When 30 seconds pass
    Then the bridge state is "unpaired"
    When ridrs asks to pair with "Pixel 8" using the code "482913"
    Then the bridge state is "connected"

  Scenario: A paired ridrs offers no QR code
    Given ridrs is paired with the companion
    When the ridrs plugins "transport-ble-bridge" are running over the simulated network
    Then the bridge state is "connected"
    And ridrs offers no pairing QR code

  Scenario: A revoked pairing offers a fresh QR code
    Given ridrs is paired with the companion
    And the companion forgot all pairings
    When the ridrs plugins "transport-ble-bridge" are running over the simulated network
    Then ridrs offers a pairing QR code

  Scenario: A stored pairing connects at start without a code
    Given ridrs is paired with the companion
    When the ridrs plugins "transport-ble-bridge" are running over the simulated network
    Then the bridge state is "connected"

  Scenario: A companion that moved to another address is found by its id
    Given ridrs is paired with the companion
    And the companion moved to another address
    When the ridrs plugins "transport-ble-bridge" are running over the simulated network
    Then the bridge state is "connected"

  Scenario: A revoked pairing asks for a new code
    Given ridrs is paired with the companion
    And the companion forgot all pairings
    When the ridrs plugins "transport-ble-bridge" are running over the simulated network
    Then the bridge state is "unpaired"
    And no pairing is stored

  Scenario: A companion that is away keeps the pairing, however the platform reports the failure
    Given ridrs is paired with the companion
    And the platform reports connection failures as plain text
    And the companion left the network
    When the ridrs plugins "transport-ble-bridge" are running over the simulated network
    And 3 seconds pass
    Then the pairing with "Pixel 8" is stored
    And the host reported a "bridge-unreachable" problem for plugin "transport-ble-bridge"
    When the companion joins the network again
    And 5 seconds pass
    Then the bridge state is "connected"
