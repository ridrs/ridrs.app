@ui
Feature: The Me area shows and changes the chosen source's athlete profile
  FTP and weight in the Me area are the chosen data source's (ADR 0073), not a preview of the
  area: they are read from the profile of the source and changed through "athlete.profile.update",
  which the host routes to the provider. A change is kept at once, handed to the next ride and
  still there when ridrs restarts. Values the Me area kept in its own preview document before the
  athlete profile existed are handed to the profile on this device once.

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-settings, ui-area-me, profile-local" together with a test device plugin "test-device"
    And the test data source plugin is installed
    And the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown

  Scenario: Without values Me shows none and the first step starts from the usual ones
    When I press "Profile"
    Then the FTP reads "–"
    And the weight reads "–"
    When I press "Raise FTP"
    And I press "Raise Weight"
    Then the FTP reads "205 W"
    And the weight reads "75.5 kg"

  Scenario: A change is kept in the profile on this device and handed to the next ride
    When I press "Profile"
    And I press "Raise FTP"
    And I press "Raise Weight"
    And I press "Raise Weight"
    Then the latest athlete handed to the next ride is from "ridrs" with an FTP of 205 W and a weight of 76 kg
    When ridrs restarted
    And I reload the UI
    And I press "Profile"
    Then the FTP reads "205 W"
    And the weight reads "76.0 kg"
    And the user settings hold the file "config/user/profile-local/athlete.json"

  Scenario: Me's old FTP and weight are handed to the profile once
    Given the Me area kept an FTP of 230 W and a weight of 80.5 kg before the athlete profile existed
    When ridrs restarted
    And I reload the UI
    And I press "Profile"
    Then the FTP reads "230 W"
    And the weight reads "80.5 kg"
    And the latest athlete handed to the next ride is from "ridrs" with an FTP of 230 W and a weight of 80.5 kg
    And the Me area keeps no FTP and no weight of its own any more
    When I press "Raise FTP"
    And ridrs restarted
    And I reload the UI
    And I press "Profile"
    Then the FTP reads "235 W"
    And the weight reads "80.5 kg"

  Scenario: The chosen source's values are shown and cannot be changed here when it is read only
    When I press "Settings"
    And I press "Fixture cloud"
    And I press "Close"
    And I press "Profile"
    Then the FTP reads "250 W"
    And the weight reads "90.0 kg"
    And the button "Raise FTP" is disabled
    And the button "Lower Weight" is disabled
    And the page says "Fixture cloud cannot be changed here."

  Scenario: A source that cannot be read shows no values
    Given the test data source is unavailable
    And ridrs restarted
    And I reload the UI
    When I press "Settings"
    And I press "Fixture cloud"
    And I press "Close"
    And I press "Profile"
    Then the FTP reads "–"
    And the button "Raise FTP" is disabled
