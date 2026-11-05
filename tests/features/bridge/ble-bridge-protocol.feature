@phase-3b @fake-timers
Feature: Forwarding BLE over the bridge
  The companion forwards raw GATT traffic to one paired ridrs over a socket.
  It never decodes payloads and trusts ridrs only after a pairing code or a token it issued.

  Background:
    Given the host clock shows "10:00:00.000"
    And a companion "Pixel 8" wrapping a simulated BLE environment with an FTMS trainer "KICKR CORE 1234"
    And the companion shows the pairing code "482913"

  Scenario: Pairing with the right code
    When ridrs connects to the companion with the code "482913"
    Then the companion welcomes ridrs and issues a token

  Scenario: A wrong code is rejected
    When ridrs connects to the companion with the code "000000"
    Then the companion rejects ridrs with the reason "bad-code"

  Scenario: Repeated wrong codes lock pairing for a minute
    Given ridrs tried the code "000000" 5 times
    When ridrs connects to the companion with the code "482913"
    Then the companion rejects ridrs with the reason "locked"
    When 60 seconds pass
    And ridrs connects to the companion with the code "482913"
    Then the companion welcomes ridrs and issues a token

  Scenario: A scanned pairing secret is accepted once
    Given the companion scanned a pairing QR code with the secret "0123456789abcdef0123456789abcdef"
    When ridrs connects to the companion with the secret "0123456789abcdef0123456789abcdef"
    Then the companion welcomes ridrs and issues a token
    When ridrs closes the connection
    And ridrs connects to the companion with the secret "0123456789abcdef0123456789abcdef"
    Then the companion rejects ridrs with the reason "unknown-secret"

  Scenario: A scanned pairing secret expires after ten minutes
    Given the companion scanned a pairing QR code with the secret "0123456789abcdef0123456789abcdef"
    When 601 seconds pass
    And ridrs connects to the companion with the secret "0123456789abcdef0123456789abcdef"
    Then the companion rejects ridrs with the reason "unknown-secret"

  Scenario: Unknown secrets do not lock out the code
    Given ridrs tried the secret "ffffffffffffffffffffffffffffffff" 10 times
    When ridrs connects to the companion with the code "482913"
    Then the companion welcomes ridrs and issues a token

  Scenario: A stored token reconnects without a code
    Given ridrs paired with the companion and kept the token
    When ridrs reconnects to the companion with the stored token
    Then the companion welcomes ridrs

  Scenario: An unknown token is rejected
    When ridrs reconnects to the companion with the token "not-a-token"
    Then the companion rejects ridrs with the reason "bad-token"

  Scenario: An incompatible protocol version is rejected
    When ridrs connects to the companion speaking protocol "2.0.0"
    Then the companion rejects ridrs with the reason "incompatible"

  Scenario: Only one ridrs at a time
    Given ridrs paired with the companion
    When a second ridrs connects to the companion with the code "482913"
    Then the companion rejects the second ridrs with the reason "busy"

  Scenario: Notification bytes arrive unchanged
    Given ridrs paired with the companion
    And ridrs is subscribed to Indoor Bike Data of "KICKR CORE 1234" through the bridge
    When the trainer sends the Indoor Bike Data packet "45 00 B4 00 C8 00"
    Then ridrs receives the notification bytes "45 00 B4 00 C8 00"

  Scenario: The companion forwards the signal and the advertising data of the devices it finds
    Given the trainer advertises the manufacturer data "0157 a1b2c3d4" and the service data "fe95 0102"
    And the trainer advertises a signal of -62 dBm
    And ridrs paired with the companion
    When ridrs looks for devices through the bridge
    Then ridrs finds "KICKR CORE 1234" with the manufacturer data "0157 a1b2c3d4" and the service data "fe95 0102"
    And ridrs finds "KICKR CORE 1234" with a signal of -62 dBm

  Scenario: A ridrs with protocol 1.1 finds the devices without signal and advertising data
    Given the trainer advertises the manufacturer data "0157 a1b2c3d4" and the service data "fe95 0102"
    And the trainer advertises a signal of -62 dBm
    And ridrs connects to the companion speaking protocol "1.1.0"
    When ridrs looks for devices through the bridge
    Then ridrs finds "KICKR CORE 1234" without signal and advertising data

  Scenario: Closing the socket releases everything on the companion
    Given ridrs paired with the companion
    And ridrs is subscribed to Indoor Bike Data of "KICKR CORE 1234" through the bridge
    When the ridrs socket closes
    Then the companion holds no subscriptions
    And the trainer "KICKR CORE 1234" is no longer connected

  Scenario: A silent ridrs is dropped by the companion
    Given ridrs paired with the companion
    And ridrs is subscribed to Indoor Bike Data of "KICKR CORE 1234" through the bridge
    When the network delivers nothing for 5 seconds
    Then the companion holds no subscriptions
    And the trainer "KICKR CORE 1234" is no longer connected
