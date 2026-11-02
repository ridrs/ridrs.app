@phase-3b @fake-timers @consistent
Feature: Both devices agree on the connection, and the rider can always change it
  ridrs and the companion show the same: connected on one side means connected on the other.
  When connected, either side can disconnect or forget the pairing; when not connected, either
  side can connect. A deliberate disconnect stays until someone connects again. "Connecting"
  never lasts forever: after 30 seconds ridrs says the companion is not reachable, and why.
  After every step of this feature, the test harness checks that both sides agree.

  Background:
    Given the host clock shows "10:00:00.000"
    And a companion "Pixel 8" wrapping a simulated BLE environment with an FTMS trainer "KICKR CORE 1234"
    And the companion shows the pairing code "482913"
    And ridrs is paired with the companion
    And the ridrs plugins "transport-ble-bridge, device-ftms-trainer" running over the simulated network

  Scenario: A paired ridrs and its companion both show the connection
    Then ridrs and the companion both show "connected"

  Scenario: Disconnecting in ridrs releases the trainer and stays disconnected
    When the rider disconnects in ridrs
    Then ridrs and the companion both show "disconnected"
    And ridrs shows that "ridrs" disconnected
    And the trainer "KICKR CORE 1234" is no longer connected
    When 60 seconds pass
    Then ridrs and the companion both show "disconnected"

  Scenario: After disconnecting in ridrs, connecting in ridrs brings the trainer back
    Given the rider disconnected in ridrs
    When the rider connects in ridrs
    And 2 seconds pass
    Then ridrs and the companion both show "connected"
    And the trainer "KICKR CORE 1234" is connected

  Scenario: After disconnecting in ridrs, connecting on the phone works too
    Given the rider disconnected in ridrs
    When the rider connects on the phone
    And 5 seconds pass
    Then ridrs and the companion both show "connected"

  Scenario: Disconnecting on the phone stays disconnected
    When the rider disconnects on the phone
    Then ridrs and the companion both show "disconnected"
    And ridrs shows that "the phone" disconnected
    When 60 seconds pass
    Then ridrs and the companion both show "disconnected"

  Scenario: After disconnecting on the phone, connecting in ridrs works
    Given the rider disconnected on the phone
    When the rider connects in ridrs
    And 2 seconds pass
    Then ridrs and the companion both show "connected"

  Scenario: A disconnect is kept when ridrs restarts
    Given the rider disconnected in ridrs
    When ridrs restarts
    And 10 seconds pass
    Then ridrs and the companion both show "disconnected"

  Scenario: A disconnect is kept when the companion restarts
    Given the rider disconnected on the phone
    When the companion restarts
    And 10 seconds pass
    Then ridrs and the companion both show "disconnected"

  Scenario: Forgetting in ridrs unpairs both
    When the rider forgets the companion in ridrs
    Then ridrs and the companion both show "not paired"
    And ridrs offers a pairing QR code

  Scenario: Forgetting on the phone unpairs both
    When the rider forgets ridrs on the phone
    Then ridrs and the companion both show "not paired"
    And ridrs offers a pairing QR code

  Scenario: Forgetting in ridrs while the phone is away reaches the phone later
    Given the companion left the network
    When the rider forgets the companion in ridrs
    And the companion joins the network again
    And 5 seconds pass
    Then ridrs and the companion both show "not paired"

  Scenario: Forgetting on the phone while ridrs is away reaches ridrs later
    Given the companion left the network
    When the rider forgets ridrs on the phone
    And the companion joins the network again
    And 10 seconds pass
    Then ridrs and the companion both show "not paired"

  Scenario: Connecting never lasts forever
    When the companion leaves the network
    Then ridrs and the companion both show "waiting"
    When 31 seconds pass
    Then the bridge state is "unreachable" with the reason "refused"
    When the companion joins the network again
    And 6 seconds pass
    Then ridrs and the companion both show "connected"

  Scenario: An unreachable companion can be forgotten in ridrs
    Given the companion left the network
    And 31 seconds pass
    When the rider forgets the companion in ridrs
    Then the bridge state is "unpaired"
    And ridrs offers a pairing QR code
