@ui
Feature: The garage
  The garage is an entry of the main menu of its own, after Me; Me keeps only the achievements.
  In the garage the rider sets the name, the weight, the shifting mode of the Di2 and the start gear; every
  change is kept at once, without a Save, and handed to the next ride (ADR 0060). Today's start
  card names the bicycle. The garage works, so it carries no "Preview" label. In a ride the gear
  widget shows the gear large as its positions, front × rear, from 1×1 to 2×12, with the chainring
  and the sprocket below it, and the arrows shift the one that has the focus.

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-activity-screen, ui-hud, ui-widget-virtual-gear, ui-widget-erg-dispatch, control-virtual-gears, ui-area-me, ui-garage" together with a test device plugin "test-device"
    And the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown

  Scenario: The menu offers the garage after Me
    Then the menu offers "Today, Me, Garage" in this order

  Scenario: Me keeps the achievements, apart from the garage
    When I press "Me"
    Then the page shows the section "Achievements" and no section "Garage"

  Scenario: The garage opens beside the menu and Back returns to Today
    When I press "Garage"
    Then the "garage" screen is shown
    And the slot "main/menu" contains the contribution "ui-main-menu/menu"
    And the menu entry "Garage" is the current page
    And the page offers no "Save" button
    And the screen is not marked as a preview
    When I press Back
    Then the "main" screen is shown

  Scenario: A change is kept at once and handed to the next ride
    When I press "Garage"
    And I press "Raise the weight"
    And I press "Raise the weight"
    And I press "Semi-synchro"
    Then the button "Semi-synchro" is on
    And the garage shows the weight "11.0 kg"
    And the latest bicycle handed to the next ride weighs 11 kg in "semi-synchro" mode
    When ridrs restarted
    And I reload the UI
    And I press "Garage"
    Then the garage shows the weight "11.0 kg"
    And the button "Semi-synchro" is on

  Scenario: Today's start card names the bicycle
    Then the start card says "Riding My bike · 10.0 kg"

  Scenario: The garage is used with the keyboard alone
    When I move the focus to "Garage"
    And I press Enter
    Then the "garage" screen is shown
    And the focus is on "Garage"
    When I press the arrow key "Down"
    Then the focus is on "Profile"
    When I press the arrow key "Down"
    Then the focus is on "Name"
    When I press the arrow key "Down"
    And I press the arrow key "Down"
    And I press the arrow key "Down"
    And I press the arrow key "Down"
    And I press the arrow key "Down"
    Then the focus is on "Full synchro"
    When I press Enter
    Then the button "Full synchro" is on
    When I press Back
    Then the "main" screen is shown

  Scenario: The gear widget shows and shifts the chainring and the sprocket
    When I press "Start ride"
    Then eventually the virtual gear widget shows gear "1×7" in "34 × 17"
    When I move the focus to "Chainring"
    And I press the arrow key "Up"
    Then eventually the virtual gear widget shows gear "2×7" in "50 × 17"
    When I move the focus to "Sprocket"
    And I press the arrow key "Up"
    Then eventually the virtual gear widget shows gear "2×8" in "50 × 15"
