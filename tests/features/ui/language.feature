@ui
Feature: The app speaks English or German
  Every text of the user interface comes from a language file of its plugin, one per language
  (ADR 0072). The language is a setting: English by default, German as the second language. The
  settings plugin owns it as app state (`app.language`), every UI plugin watches it, so a change
  takes effect at once in everything shown, and it is kept when ridrs restarts.

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-devices, ui-area-ride, ui-route-profile, ui-area-training, ui-area-events, ui-area-me, ui-garage, ui-search, ui-settings" together with a test device plugin "test-device"
    And the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown

  Scenario: English is the default
    Then the menu offers "Today, Ride, Training, Events" in this order
    And the top bar offers "Search, Devices, Settings, Garage, Profile" in this order
    When I press "Settings"
    Then the button "English" is on

  Scenario: Choosing German changes everything shown at once
    When I press "Settings"
    And I press "Deutsch"
    Then the button "Deutsch" is on
    And the screen shows the heading "Einstellungen"
    When I press "Schließen"
    Then the menu offers "Heute, Fahren, Training, Events" in this order
    And the top bar offers "Suche, Geräte, Einstellungen, Garage, Profil" in this order
    When I press "Fahren"
    Then the "ride" screen is shown
    And the screen shows the heading "Fahren"

  Scenario: The language is kept when ridrs restarts
    When I press "Settings"
    And I press "Deutsch"
    And ridrs restarted
    And I reload the UI
    Then the menu offers "Heute, Fahren, Training, Events" in this order
    And the user settings hold the file "config/user/ui-settings/language.json"

  Scenario: Back to English
    When I press "Settings"
    And I press "Deutsch"
    And I press "English"
    Then the screen shows the heading "Settings"
    When I press "Close"
    Then the menu offers "Today, Ride, Training, Events" in this order
