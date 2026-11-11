@ui
Feature: The Me area shows and edits the zones of the athlete profile
  The Me area shows the power zones and heart rate zones of the chosen source (ADR 0082): names,
  bounds in % FTP and, with an FTP, in watts; heart rate in bpm. The rider edits bounds and names,
  adds and removes zones up to ten, or resets to the defaults, and saves with the page's Save
  (ADR 0078). The zones are validated as the contract says. Without an FTP a discreet hint says
  that power zones need one.

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-settings, ui-area-me, profile-local" together with a test device plugin "test-device"
    And the test data source plugin is installed
    And the athlete profile on this device holds an FTP of 250 W and an LTHR of 170 bpm
    And the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown

  Scenario: The default zones are shown in % FTP, in watts and in bpm
    When I press "Profile"
    Then power zone 1 reads "Active Recovery", "55" and "up to 138 W"
    And power zone 4 reads "Threshold", "105" and "up to 263 W"
    And the last power zone reads "Neuromuscular Power" and "above 150 % FTP"
    And heart rate zone 1 reads "Recovery" and "138"
    And heart rate zone 6 reads "Aerobic Capacity" and "180"

  Scenario: Without an FTP there are no watts and a hint says why
    Given the athlete profile on this device holds an LTHR of 170 bpm only
    And ridrs restarted
    And I reload the UI
    When I press "Profile"
    Then power zone 1 reads "Active Recovery", "55" and ""
    And the page says "Power zones in watts need an FTP."

  Scenario: A changed bound is saved and kept
    When I press "Profile"
    And I set the bound of power zone 3 to "92"
    Then the page says "Not saved yet."
    When I press "Save"
    Then power zone 3 reads "Tempo", "92" and "up to 230 W"
    When ridrs restarted
    And I reload the UI
    And I press "Profile"
    Then power zone 3 reads "Tempo", "92" and "up to 230 W"

  Scenario: A renamed zone is saved
    When I press "Profile"
    And I name power zone 2 "Base"
    And I press "Save"
    Then power zone 2 reads "Base", "75" and "up to 188 W"

  Scenario: A bound that does not rise is refused with its reason
    When I press "Profile"
    And I set the bound of power zone 3 to "70"
    Then the page says "Power zone: the upper bounds must rise."
    And the button "Save" is disabled

  Scenario: Zones are added up to ten and removed
    When I press "Profile"
    And I press "Add Power zone"
    And I press "Add Power zone"
    And I press "Add Power zone"
    Then the power zones number 10
    And the button "Add Power zone" is disabled
    When I press "Remove Power zone 10"
    Then the power zones number 9
    When I press "Save"
    And ridrs restarted
    And I reload the UI
    And I press "Profile"
    Then the power zones number 9

  Scenario: Reset to defaults
    When I press "Profile"
    And I set the bound of power zone 3 to "92"
    And I press "Save"
    And I press "Reset Power zones to defaults"
    And I press "Save"
    Then power zone 3 reads "Tempo", "90" and "up to 225 W"

  Scenario: The heart rate zones follow the LTHR until the rider sets their own
    When I press "Profile"
    And I set the bound of heart rate zone 1 to "140"
    And I press "Save"
    Then heart rate zone 1 reads "Recovery" and "140"

  Scenario: A source without zones shows none and offers none
    When I press "Settings"
    And I press "Fixture cloud"
    And I press "Close"
    And I press "Profile"
    Then the page offers no "Add Power zone" button

  Scenario: The zones are in German
    When I press "Settings"
    And I press "Deutsch"
    And I press "Close"
    And I press "Profil"
    Then the page shows the section "Trainingszonen"
    And the page says "Leistungszonen"
    And the page says "Herzfrequenzzonen"
    And the page offers a "Leistungszone hinzufügen" button
    When I set the bound of power zone 3 to "70"
    Then the page says "Leistungszone: die Obergrenzen müssen steigen."
