@ui @training
Feature: The Me area writes the athlete profile to intervals.icu
  With intervals.icu chosen as the source of the athlete profile (ADR 0075), a change of the
  weight in Me is written to today's wellness record, and a change of the FTP to the Ride settings,
  into the field the FTP was read from: the indoor FTP where one is set, else the FTP. The weight
  of the athlete is never written. A write is refused, never queued: when intervals.icu cannot be
  reached, or the token lacks the scope (403, the rider connects again), the old value stays.

  Here intervals.icu, the browser and the secret store are simulated.

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-settings, ui-area-me, profile-local, planner-intervals-icu, ui-training-plan" together with the simulated intervals.icu
    And a test device plugin "test-device"
    And intervals.icu knows the athlete "Alex Rider" with an FTP of 250 W and a weight of 72 kg
    And the local time is "2026-11-04 08:00"
    And the secret store holds a token for intervals.icu
    And the host has started
    And the athlete profile of "intervals.icu" is in use
    And the main screen is 1400 px wide
    And the ridrs UI is shown

  Scenario: Connecting asks for the scopes of the writes
    When I press "Profile"
    And I press "Disconnect intervals.icu"
    And I press "Connect intervals.icu"
    Then the browser was opened at "https://intervals.icu/oauth/authorize" with:
      | scope | SETTINGS:WRITE,CALENDAR:READ,WELLNESS:WRITE,LIBRARY:READ,ACTIVITY:WRITE |

  Scenario: A new weight is written to today's wellness record
    When I press "Profile"
    Then the FTP reads "250 W"
    When I press "Raise Weight"
    Then intervals.icu received "PUT /api/v1/athlete/0/wellness/2026-11-04" with the body:
      | weight | 72.5 |
    And the weight reads "72.5 kg"
    And no request changed the athlete of intervals.icu
    And the latest athlete handed to the next ride is from "intervals.icu" with an FTP of 250 W and a weight of 72.5 kg
    When ridrs restarted
    And I reload the UI
    And I press "Profile"
    Then the weight reads "72.5 kg"

  Scenario: A new FTP is written to the FTP of the Ride settings
    When I press "Profile"
    Then the FTP reads "250 W"
    When I press "Raise FTP"
    Then intervals.icu received "PUT /api/v1/athlete/0/sport-settings/Ride" with the body:
      | ftp | 255 |
    And the FTP reads "255 W"
    And the latest athlete handed to the next ride is from "intervals.icu" with an FTP of 255 W and a weight of 72 kg

  Scenario: Where an indoor FTP is set, it is the one written
    Given intervals.icu keeps an indoor FTP of 240 W
    And ridrs restarted
    And I reload the UI
    When I press "Profile"
    Then the FTP reads "240 W"
    When I press "Lower FTP"
    Then intervals.icu received "PUT /api/v1/athlete/0/sport-settings/Ride" with the body:
      | indoor_ftp | 235 |
    And the FTP reads "235 W"

  Scenario: A token without the scope is rejected, the rider is asked to connect again
    Given intervals.icu rejects writes with 403
    When I press "Profile"
    Then the FTP reads "250 W"
    When I press "Raise Weight"
    Then the FTP reads "250 W"
    And the weight reads "72.0 kg"
    And the Me area offers a "Reconnect intervals.icu" button
    And the secret store holds no intervals.icu token
    And the latest athlete handed to the next ride is from "intervals.icu" with an FTP of 250 W and a weight of 72 kg

  Scenario: Connecting again allows the change
    Given intervals.icu rejects writes with 403
    When I press "Profile"
    Then the FTP reads "250 W"
    When I press "Raise Weight"
    And intervals.icu accepts writes
    And I press "Reconnect intervals.icu"
    And the athlete approves the sign-in
    Then the Me area shows "Connected as Alex Rider"
    And the button "Raise Weight" is enabled
    When I press "Raise Weight"
    Then the weight reads "72.5 kg"

  Scenario: When intervals.icu cannot be reached the change is refused and the old value stays
    Given intervals.icu cannot be reached for writes
    When I press "Profile"
    Then the FTP reads "250 W"
    When I press "Raise Weight"
    Then the page says "intervals.icu could not be reached: the value stays as it was."
    And the weight reads "72.0 kg"
    When intervals.icu can be reached for writes
    And I press "Raise Weight"
    Then the weight reads "72.5 kg"

  Scenario: Offline, the change is refused as well
    Given the host is restarted while intervals.icu is unreachable
    And I reload the UI
    When I press "Profile"
    Then the FTP reads "250 W"
    When I press "Raise Weight"
    Then the page says "intervals.icu could not be reached: the value stays as it was."
    And the weight reads "72.0 kg"
