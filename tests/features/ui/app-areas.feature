@ui
Feature: The app's areas as a clickable preview
  The main menu has five areas by the rider's intent: Today (the main screen), Ride, Training,
  Events and Me (docs/ideas/main-menu-structure.md). Search, the device status, Settings and the
  profile are global actions in the top bar. Every area and every global screen is a plugin of
  its own, shown beside the menu in the main screen's content area, as the main screen's layout
  names them (ADR 0058). In this early alpha most of their content is a placeholder, marked
  "Preview" so that nobody takes it for a working feature (ADR 0059).

  Background:
    Given the ridrs plugins "activity-session, device-registry, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-devices, ui-area-ride, ui-area-training, ui-area-events, ui-area-me, ui-search, ui-settings" together with a test device plugin "test-device"
    And the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown

  Scenario: The menu offers the five areas
    Then the menu offers "Today, Ride, Training, Events, Me" in this order
    And the menu entry "Today" is the current page

  Scenario Outline: An area opens beside the menu
    When I press "<entry>"
    Then the "<screen>" screen is shown
    And the slot "main/menu" contains the contribution "ui-main-menu/menu"
    And the menu entry "<entry>" is the current page
    And the screen is marked as a preview
    When I press "Today"
    Then the "main" screen is shown

    Examples:
      | entry    | screen   |
      | Ride     | ride     |
      | Training | training |
      | Events   | events   |
      | Me       | me       |

  Scenario: The top bar offers the global actions
    Then the top bar offers "Search, Devices, Settings, Profile" in this order

  Scenario Outline: A global action opens its screen beside the menu
    When I press "<action>"
    Then the "<screen>" screen is shown
    And the slot "main/menu" contains the contribution "ui-main-menu/menu"

    Examples:
      | action   | screen   |
      | Search   | search   |
      | Devices  | setup    |
      | Settings | settings |
      | Profile  | me       |

  Scenario: The global actions stay on a narrow screen without the top bar
    Given the main screen is 400 px wide
    Then the top bar is not shown
    And the top bar offers "Search, Devices, Settings, Profile" in this order

  Scenario: The arrows walk through the menu, then the global actions, then the tiles
    When I press the arrow key "Down"
    Then the focus is on "Today"
    When I press the arrow key "Down"
    And I press the arrow key "Down"
    And I press the arrow key "Down"
    And I press the arrow key "Down"
    Then the focus is on "Me"
    When I press the arrow key "Down"
    Then the focus is on "Search"
    When I press the arrow key "Down"
    And I press the arrow key "Down"
    And I press the arrow key "Down"
    Then the focus is on "Profile"
    When I press the arrow key "Down"
    Then the focus is on "Start ride"

  Scenario: No area asks to save
    When I press "Ride"
    Then the page offers no "Save" button
    When I press "Training"
    Then the page offers no "Save" button
    When I press "Events"
    Then the page offers no "Save" button
    When I press "Me"
    Then the page offers no "Save" button
    When I press "Settings"
    Then the page offers no "Save" button

  Scenario: The areas do not know each other or the main screen
    Then the manifest and the client of "ui-area-ride" mention none of "ui-main-screen, ui-area-training, ui-area-events, ui-area-me, ui-search"
    And the manifest and the client of "ui-search" mention none of "ui-main-screen, ui-area-ride, ui-area-training, ui-area-events, ui-area-me"
