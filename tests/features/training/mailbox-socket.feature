@ui @training @mailbox
Feature: The app keeps a socket to the relay and hears of changes at once
  While the app runs and the account is connected, a socket to the relay delivers the events of
  intervals.icu as they arrive (ADR 0079). The mailbox stays the source of truth: on every
  connect the socket opens first and then the app fetches what is waiting. Pushed events go through
  the same path as fetched ones, so each is applied once. A newer connection of the device closes
  the older with 4000, and the app does not reconnect then. Nothing polls intervals.icu.

  Here intervals.icu, the relay, the browser and the secret store are simulated. It is Wednesday 4
  November 2026.

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-settings, ui-area-me, profile-local, planner-intervals-icu, ui-training-plan" together with the simulated intervals.icu
    And the relay offers a socket
    And a test device plugin "test-device"
    And intervals.icu knows the athlete "Alex Rider" with an FTP of 250 W and a weight of 72 kg
    And intervals.icu plans:
      | date       | type | name         | duration | load |
      | 2026-11-05 | Ride | Threshold 20 | 1h       | 80   |
    And the local time is "2026-11-04 08:00"
    And the host has started
    And the ridrs UI is shown
    When I press "Connect intervals.icu"
    And the athlete approves the sign-in
    Then the training tile shows "Connected as Alex Rider"
    And the app holds a socket to the relay
    And the simulated intervals.icu forgets the requests so far
    And the relay forgets the requests so far

  Scenario: An event pushed while connected is applied at once without a request to intervals.icu
    When intervals.icu sends the webhook "CALENDAR_UPDATED":
      """
      { "events": [ { "id": 71001, "category": "WORKOUT", "type": "Ride", "name": "Webhook Tempo",
          "start_date_local": "2026-11-04T00:00:00", "moving_time": 2400 } ], "deleted_events": [] }
      """
    Then the next workout card shows "Webhook Tempo" at once
    And intervals.icu received 0 requests
    And the relay holds 0 events
    And the relay received 0 requests "POST /updates/ack"

  Scenario: After a drop the app reconnects, catches up, and applies each event once
    When the network drops the socket
    And intervals.icu sends the webhook "CALENDAR_UPDATED":
      """
      { "events": [ { "id": 71001, "category": "WORKOUT", "type": "Ride", "name": "Webhook Tempo",
          "start_date_local": "2026-11-04T00:00:00", "moving_time": 2400 } ], "deleted_events": [] }
      """
    Then the relay accepted 2 sockets
    And the next workout card shows "Webhook Tempo" at once
    And the relay received 1 requests "GET /updates"
    And the relay holds 0 events
    And intervals.icu received 0 requests

  Scenario: Code 4000 means another connection took over: no reconnect
    When another connection of the device replaces the socket
    And a moment passes
    Then the relay accepted 1 sockets
    And the app holds no socket to the relay

  Scenario: Nothing polls intervals.icu while the socket is open
    When a moment passes
    Then intervals.icu received 0 requests
    And the app holds a socket to the relay

  Scenario: Disconnecting closes the socket
    When I press "Profile"
    And I press "Disconnect intervals.icu"
    Then the app holds no socket to the relay
    And the relay forgot the device

  Scenario: A refused socket for a skewed clock is checked, keeps the keys and connects again
    When the relay answers 1 requests with a 401 for the time of the request
    And the network drops the socket
    Then the relay accepted 2 sockets
    And the secret store still holds the keys and the device id of the mailbox

  Scenario: A refused socket of an unknown device drops the keys and stays closed
    When the relay no longer knows the device
    And the network drops the socket
    Then the secret store holds no keys and no device id of the mailbox
    And the app holds no socket to the relay
