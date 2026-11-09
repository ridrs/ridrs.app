@ui @training @mailbox
Feature: The relay's mailbox tells the app what changed in intervals.icu
  After the sign-in the app registers this device at the relay of ridrs (ADR 0079): two public
  keys and the token, once. The relay seals every webhook event of intervals.icu for the device;
  the app fetches them with signed requests at start, opens them, applies what the payload says
  without asking intervals.icu, and acknowledges them. The events of its own writes and events it
  has seen are not applied again. Without the relay the app works as before, and says nothing.

  Here intervals.icu, the relay, the browser and the secret store are simulated. It is Wednesday 4
  November 2026.

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-settings, ui-area-me, profile-local, planner-intervals-icu, ui-training-plan" together with the simulated intervals.icu
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

  Scenario: Signing in registers the device, with the token sent once and the keys kept secret
    Then the relay registered a device
    And the relay got the token once, in the registration
    And the secret store holds the keys and the device id of the mailbox
    And no app file holds a key or a token

  Scenario: A calendar change is applied at the next start without a request to intervals.icu
    When intervals.icu sends the webhook "CALENDAR_UPDATED":
      """
      { "events": [ { "id": 71001, "category": "WORKOUT", "type": "Ride", "name": "Webhook Tempo",
          "start_date_local": "2026-11-04T00:00:00", "moving_time": 2400, "icu_training_load": 55 } ],
        "deleted_events": [] }
      """
    And the simulated intervals.icu forgets the requests so far
    And the relay forgets the requests so far
    And ridrs restarted
    And I reload the UI
    Then the next workout card shows:
      | name | Webhook Tempo |
    And intervals.icu received 0 requests
    And the relay received 1 requests "GET /updates"
    And the relay received 1 requests "POST /updates/ack"
    And the relay holds 0 events

  Scenario: A deleted event leaves the calendar
    When intervals.icu sends the webhook "CALENDAR_UPDATED":
      """
      { "events": [], "deleted_events": [ <id:Threshold 20> ] }
      """
    And the simulated intervals.icu forgets the requests so far
    And ridrs restarted
    And I reload the UI
    Then the training tile shows "No workout planned"
    And intervals.icu received 0 requests

  Scenario: An event delivered again, or an older one after a newer one, changes nothing
    When intervals.icu sends the webhook "CALENDAR_UPDATED" at "2026-11-04T10:00:00":
      """
      { "events": [ { "id": 71001, "category": "WORKOUT", "type": "Ride", "name": "Webhook Tempo",
          "start_date_local": "2026-11-04T00:00:00", "moving_time": 2400 } ], "deleted_events": [] }
      """
    And intervals.icu sends the webhook "CALENDAR_UPDATED" at "2026-11-04T10:05:00":
      """
      { "events": [], "deleted_events": [ 71001 ] }
      """
    And the relay delivers the last event again
    And ridrs restarted
    And I reload the UI
    Then the next workout card shows:
      | name | Threshold 20 |

  Scenario: An event of our own writes is not applied
    When intervals.icu sends the webhook "CALENDAR_UPDATED":
      """
      { "oauth_client_id": "1697", "events": [ { "id": 71002, "category": "WORKOUT", "type": "Ride",
          "name": "Our Own Echo", "start_date_local": "2026-11-04T00:00:00" } ], "deleted_events": [] }
      """
    And ridrs restarted
    And I reload the UI
    Then the next workout card shows:
      | name | Threshold 20 |

  Scenario: Settings with an FTP are applied without a request
    When intervals.icu sends the webhook "SPORT_SETTINGS_UPDATED":
      """
      { "sportSettings": [ { "types": [ "Ride", "VirtualRide" ], "ftp": 262 } ] }
      """
    And the simulated intervals.icu forgets the requests so far
    And ridrs restarted
    And I reload the UI
    And I open the next workout
    Then the workout details show the athlete's FTP "262 W" and weight "72 kg"
    And intervals.icu received 0 requests

  Scenario: Settings without an FTP read the athlete's settings once
    When intervals.icu sends the webhook "SPORT_SETTINGS_UPDATED":
      """
      { "sportSettings": [] }
      """
    And the simulated intervals.icu forgets the requests so far
    And ridrs restarted
    Then intervals.icu received 1 requests
    And intervals.icu received 1 requests "GET /api/v1/athlete/0"

  Scenario: A new activity reads the plan again
    When intervals.icu sends the webhook "ACTIVITY_UPLOADED":
      """
      { "activity": { "id": "i90001", "external_id": "session-from-elsewhere" } }
      """
    And the simulated intervals.icu forgets the requests so far
    And ridrs restarted
    Then intervals.icu received 2 requests
    And intervals.icu received 1 requests "GET /api/v1/athlete/0/events"

  Scenario: Wellness changes read the athlete again
    When intervals.icu sends the webhook "WELLNESS_UPDATED":
      """
      { "wellness": [] }
      """
    And the simulated intervals.icu forgets the requests so far
    And ridrs restarted
    Then intervals.icu received 2 requests
    And intervals.icu received 1 requests "GET /api/v1/athlete/0/wellness/*"

  Scenario: Without the relay the app works as before and says nothing
    Given the relay cannot be reached
    And ridrs restarted
    And I reload the UI
    Then the training tile shows "Connected as Alex Rider"
    And the next workout card shows:
      | name | Threshold 20 |

  Scenario: Disconnecting tells the relay and drops the keys
    When I press "Profile"
    And I press "Disconnect intervals.icu"
    Then the relay forgot the device
    And the secret store holds no keys and no device id of the mailbox
    And the secret store holds no intervals.icu token

  Scenario: A 401 for the time of a request is retried once with a fresh timestamp and keeps the keys
    When intervals.icu sends the webhook "CALENDAR_UPDATED":
      """
      { "events": [ { "id": 71001, "category": "WORKOUT", "type": "Ride", "name": "Webhook Tempo",
          "start_date_local": "2026-11-04T00:00:00", "moving_time": 2400 } ], "deleted_events": [] }
      """
    And the relay answers 1 requests with a 401 for the time of the request
    And the relay forgets the requests so far
    And ridrs restarted
    And I reload the UI
    Then the next workout card shows:
      | name | Webhook Tempo |
    And the relay received 2 requests "GET /updates"
    And the secret store still holds the keys and the device id of the mailbox

  Scenario: A 401 that stays does not forget the keys, and says nothing
    When the relay answers 5 requests with a 401 for the time of the request
    And the relay forgets the requests so far
    And ridrs restarted
    And I reload the UI
    Then the training tile shows "Connected as Alex Rider"
    And the relay received 2 requests "GET /updates"
    And the secret store still holds the keys and the device id of the mailbox

  Scenario: Only the code unknown_device drops the keys
    When the relay no longer knows the device
    And ridrs restarted
    Then the secret store holds no keys and no device id of the mailbox

  Scenario: A fresh sign-in registers a new device and deletes the old one, with new keys
    Given the keys and the device id of the mailbox are noted
    And intervals.icu rejects the token
    And the local time is "2026-11-04 10:00"
    And ridrs restarted
    And I reload the UI
    And I press "Reconnect intervals.icu"
    When the athlete approves the sign-in
    Then the training tile shows "Connected as Alex Rider"
    And the relay registered 2 devices
    And the relay deleted the noted device
    And the mailbox has other keys and another device id than noted
    And the secret store holds the keys and the device id of the mailbox
