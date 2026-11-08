@ui
Feature: The rider chooses where the athlete profile comes from
  A data type has one source of truth, chosen from every provider that offers it (ADR 0073). The
  settings page has a section "Data sources" with a row for the athlete profile: one button per
  provider, the chosen one pressed, and the source's status beside it. The host side of the
  settings plugin keeps the choice and hands the chosen profile to the next ride. ridrs on this
  device is always there and the default; if the chosen provider goes away, ridrs takes its
  place. The test data source ("Fixture cloud") is a second provider.

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-settings, profile-local" together with a test device plugin "test-device"
    And the test data source plugin is installed
    And the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown

  Scenario: Settings lists every provider of the athlete profile
    When I press "Settings"
    Then the page shows the section "Data sources"
    And the row "Athlete profile" offers "ridrs (this device), Fixture cloud"
    And the row "Athlete profile" has "ridrs (this device)" chosen
    And the row "Athlete profile" shows the status "Ready"

  Scenario: Choosing a provider hands its profile to the next ride
    When I press "Settings"
    And I press "Fixture cloud"
    Then the row "Athlete profile" has "Fixture cloud" chosen
    And the latest athlete handed to the next ride is from "fixture-cloud" with an FTP of 250 W and a weight of 90 kg

  Scenario: The choice is kept when ridrs restarts
    When I press "Settings"
    And I press "Fixture cloud"
    And ridrs restarted
    And I reload the UI
    And I press "Settings"
    Then the row "Athlete profile" has "Fixture cloud" chosen
    And the user settings hold the file "config/user/ui-settings/data-sources.json"

  Scenario: A provider that goes away is replaced by ridrs
    When I press "Settings"
    And I press "Fixture cloud"
    And the plugin "fixture-transport-athlete" is stopped
    Then the row "Athlete profile" offers "ridrs (this device)"
    And the row "Athlete profile" has "ridrs (this device)" chosen
    And the latest athlete handed to the next ride is from "ridrs" without values

  Scenario: A chosen provider that is no longer installed gives way to ridrs
    When I press "Settings"
    And I press "Fixture cloud"
    And the test data source plugin is removed
    And ridrs restarted
    And I reload the UI
    And I press "Settings"
    Then the row "Athlete profile" offers "ridrs (this device)"
    And the row "Athlete profile" has "ridrs (this device)" chosen

  Scenario: The status of a provider that is offline
    Given the test data source is offline
    And ridrs restarted
    And I reload the UI
    When I press "Settings"
    And I press "Fixture cloud"
    Then the row "Athlete profile" shows a status starting with "Offline · last loaded"

  Scenario: The status of a provider that cannot be read
    Given the test data source is unavailable
    And ridrs restarted
    And I reload the UI
    When I press "Settings"
    And I press "Fixture cloud"
    Then the row "Athlete profile" shows the status "Not available"
    And the latest athlete handed to the next ride is from "fixture-cloud" without values

  Scenario: An unavailable source gives the ride the defaults, and the start card says so
    Given the test data source is unavailable
    And ridrs restarted
    And I reload the UI
    Then the start card notes nothing
    When I press "Settings"
    And I press "Fixture cloud"
    Then the start card notes "Your athlete profile is not available: the next ride uses default values."
    And the latest athlete handed to the next ride is from "fixture-cloud" without values
    When I press "ridrs (this device)"
    Then the start card notes nothing

  Scenario: The choice is made with the keyboard alone
    When I move the focus to "Settings"
    And I press Enter
    And I move the focus to "Fixture cloud"
    Then the focus is on "Fixture cloud"
    When I press Enter
    Then the row "Athlete profile" has "Fixture cloud" chosen
    When I press Back
    Then the "main" screen is shown
    And the focus is on "Settings"

  Scenario: The settings are in German
    When I press "Settings"
    And I press "Deutsch"
    Then the page shows the section "Datenquellen"
    And the row "Athletenprofil" offers "ridrs (dieses Gerät), Fixture cloud"
    And the row "Athletenprofil" shows the status "Bereit"

  Scenario: During a ride a change applies from the next ride
    When I press "Start ride"
    And I press "Settings"
    Then the page says "A ride is under way: a new source applies from the next ride."
