@ui @training
Feature: intervals.icu is a source of the athlete profile
  intervals.icu is a provider of the athlete profile (ADR 0075), next to ridrs on this device. Its
  FTP is the indoor FTP of its Ride settings (else the FTP), its weight today's wellness weight
  (else the weight of the athlete). The first start of this version chooses it when its account
  is connected, so the rider keeps seeing what they saw before; a choice the rider made is kept.
  Offline, the cached profile stands in and is marked as such. Disconnected, the source is not
  available and the next ride uses the default values: the profile on this device does not take
  its place.

  Here intervals.icu, the browser and the secret store are simulated.

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-settings, ui-area-me, profile-local, planner-intervals-icu, ui-training-plan" together with the simulated intervals.icu
    And a test device plugin "test-device"
    And intervals.icu knows the athlete "Alex Rider" with an FTP of 250 W and a weight of 72 kg
    And the local time is "2026-11-04 08:00"

  Scenario: The first start chooses intervals.icu when its account is connected
    Given the secret store holds a token for intervals.icu
    And the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Settings"
    Then the row "Athlete profile" offers "ridrs (this device), intervals.icu"
    And the row "Athlete profile" has "intervals.icu" chosen
    And the row "Athlete profile" shows a status starting with "Ready"
    And the latest athlete handed to the next ride is from "intervals.icu" with an FTP of 250 W and a weight of 72 kg
    When I press Back
    And I press "Profile"
    Then the FTP reads "250 W"
    And the weight reads "72.0 kg"

  Scenario: The first start without an account keeps ridrs
    Given the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Settings"
    Then the row "Athlete profile" offers "ridrs (this device), intervals.icu"
    And the row "Athlete profile" has "ridrs (this device)" chosen
    When I press "intervals.icu"
    Then the row "Athlete profile" shows the status "Not available"

  Scenario: A choice the rider made is kept at the next start
    Given the secret store holds a token for intervals.icu
    And the rider chose the athlete profile of "ridrs"
    And the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Settings"
    Then the row "Athlete profile" has "ridrs (this device)" chosen

  Scenario: Connecting later does not change the choice
    Given the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Profile"
    And I press "Connect intervals.icu"
    And the athlete approves the sign-in
    And ridrs restarted
    And I reload the UI
    And I press "Settings"
    Then the row "Athlete profile" has "ridrs (this device)" chosen

  Scenario: Today's wellness weight is the weight, else the weight of the athlete
    Given the secret store holds a token for intervals.icu
    And intervals.icu holds a wellness weight of 71.2 kg for "2026-11-04"
    And the host has started
    Then intervals.icu received "GET /api/v1/athlete/0/wellness/2026-11-04" with the token
    And the latest athlete handed to the next ride is from "intervals.icu" with an FTP of 250 W and a weight of 71.2 kg

  Scenario: A wellness weight of another day is not today's
    Given the secret store holds a token for intervals.icu
    And intervals.icu holds a wellness weight of 71.2 kg for "2026-11-03"
    And the host has started
    Then the latest athlete handed to the next ride is from "intervals.icu" with an FTP of 250 W and a weight of 72 kg

  Scenario: The indoor FTP is the FTP
    Given the secret store holds a token for intervals.icu
    And intervals.icu keeps an indoor FTP of 240 W
    And the host has started
    Then the latest athlete handed to the next ride is from "intervals.icu" with an FTP of 240 W and a weight of 72 kg

  Scenario: The next ride is ridden with intervals.icu's weight
    Given the secret store holds a token for intervals.icu
    And the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Start ride"
    Then the ride froze an athlete of 72 kg from "intervals.icu"

  Scenario: Offline, the cached profile stands in and is marked
    Given the secret store holds a token for intervals.icu
    And the host has started
    And the host is restarted while intervals.icu is unreachable
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Settings"
    Then the row "Athlete profile" has "intervals.icu" chosen
    And the row "Athlete profile" shows a status starting with "Offline · last loaded"
    And the latest athlete handed to the next ride is from "intervals.icu" with an FTP of 250 W and a weight of 72 kg
    When I press Back
    And I press "Profile"
    Then the FTP reads "250 W"

  Scenario: Disconnected, the source is not available and the ride uses the defaults
    Given the secret store holds a token for intervals.icu
    And the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Profile"
    And I press "Disconnect intervals.icu"
    Then the FTP reads "–"
    And the weight reads "–"
    And the latest athlete handed to the next ride is from "intervals.icu" without values
    When I press Back
    And I press "Settings"
    Then the row "Athlete profile" has "intervals.icu" chosen
    And the row "Athlete profile" shows the status "Not available"
    When I press Back
    Then the start card notes "Your athlete profile is not available: the next ride uses default values."
    When I press "Start ride"
    Then the ride froze an athlete without a weight from "intervals.icu"

  Scenario: A rejected token makes the source unavailable
    Given the secret store holds a token for intervals.icu
    And intervals.icu rejects the token
    And the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Settings"
    And I press "intervals.icu"
    Then the row "Athlete profile" shows the status "Not available"
