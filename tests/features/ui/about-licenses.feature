@ui
Feature: About and licenses
  The settings end with an About section: the app's name and version, its license (GNU AGPL v3 or
  later) and a link to its source code, as AGPL section 5(d) asks of an interactive user interface.
  A "Licenses & credits" page inside the settings lists every third-party component of the NOTICE
  file with its version, license and purpose, shows the full license text of the one chosen and
  credits third-party content. The list is generated from NOTICE and the license files the
  repository keeps (ADR 0073), so it cannot drift from them. All of it works with the arrows,
  Enter and Back alone, in English and German (ADR 0072).

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-devices, ui-settings" together with a test device plugin "test-device"
    And the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown

  Scenario: The settings end with the About section
    When I press "Settings"
    Then the screen shows the section "About"
    And the screen shows the text "ridrs"
    And the screen shows the app version
    And the screen shows the text "Licensed under GNU AGPL v3 or later"
    And the screen links "Source code" to "https://github.com/ridrs/ridrs.app"
    And the page offers a "Licenses & credits" button

  Scenario: Licenses and credits are reached with the keyboard alone and Back leaves them
    When I move the focus to "Settings"
    And I press Enter
    And I move the focus to "Licenses & credits"
    And I press Enter
    Then the screen shows the heading "Licenses & credits"
    When I press Back
    Then the screen shows the heading "Settings"
    When I press Back
    Then no dialog is shown
    And the "main" screen is shown

  Scenario: Every entry of the NOTICE file is listed
    When I press "Settings"
    And I press "Licenses & credits"
    Then the licenses list every entry of the NOTICE file with its version, license and purpose

  Scenario: Choosing an entry shows its full license text and Back returns to the list
    When I press "Settings"
    And I press "Licenses & credits"
    And I press the license entry "rxjs"
    Then the screen shows the heading "rxjs"
    And the license text contains "Apache License"
    When I press Back
    Then the screen shows the heading "Licenses & credits"

  Scenario: An entry is chosen with the keyboard alone
    When I move the focus to "Settings"
    And I press Enter
    And I move the focus to "Licenses & credits"
    And I press Enter
    And I move the focus to the license entry "zod"
    And I press Enter
    Then the license text contains "Permission is hereby granted"

  Scenario: Every entry has a license text
    When I press "Settings"
    And I press "Licenses & credits"
    Then every license entry has a license text

  Scenario: The app's own license is shown in full
    When I press "Settings"
    And I press "Licenses & credits"
    And I press "ridrs itself"
    Then the license text contains "GNU AFFERO GENERAL PUBLIC LICENSE"

  Scenario: Third-party content is credited
    When I press "Settings"
    And I press "Licenses & credits"
    Then the credits name "Fred Van Gestel" and the license "CC-BY-NC-SA-4.0"

  Scenario: All of it is in German
    When I press "Settings"
    And I press "Deutsch"
    Then the screen shows the section "Über ridrs"
    And the screen shows the text "Lizenziert unter der GNU AGPL v3 oder neuer"
    When I press "Lizenzen & Danksagungen"
    Then the screen shows the heading "Lizenzen & Danksagungen"
    And the screen shows the text "Drittinhalte"
    When I press the license entry "rxjs"
    Then the license text contains "Apache License"
