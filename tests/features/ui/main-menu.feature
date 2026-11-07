@ui
Feature: The main menu
  The menu on the main screen has one entry per area. Its own entry, Today, is the main screen;
  every other entry is a contribution of the plugin that owns the area's screen, so the menu does
  not know them. The screens that the main screen's layout names (the areas) are shown in its
  content area instead of the tiles, so the menu stays where it is and marks that screen's entry
  as the current page.

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-main-menu, ui-tile-ride-start, ui-devices, ui-area-ride, ui-landscape-demo" together with a test device plugin "test-device"
    And the host has started
    And the ridrs UI is shown

  Scenario: The menu offers Today and the areas of other plugins
    Then the menu offers "Today, Ride" in this order
    And the menu entry "Today" is the current page

  Scenario: Ride opens its area, and Back returns to the main screen
    When I press "Ride"
    Then the "ride" screen is shown
    When I press Back
    Then the "main" screen is shown

  Scenario: The menu stays while an area is shown
    When I press "Ride"
    Then the "ride" screen is shown
    And the slot "main/menu" contains the contribution "ui-main-menu/menu"
    And the menu entry "Ride" is the current page
    And the main screen shows no tiles
    When I press "Today"
    Then the "main" screen is shown
    And the menu entry "Today" is the current page
    And the main screen shows the tiles:
      | tile                          | columns |
      | ui-tile-ride-start/ride-start | 12      |
      | ui-devices/devices            | 6       |
      | ui-area-ride/ride-again       | 6       |

  Scenario: The menu keeps the focus while an area opens
    When I move the focus to "Ride"
    And I press Enter
    Then the "ride" screen is shown
    And the focus is on "Ride"

  Scenario: The menu does not know its entries
    Then the manifest and the client of "ui-main-menu" mention none of "ui-area-ride, ui-devices, setup"
