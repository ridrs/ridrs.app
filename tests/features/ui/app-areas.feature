@ui
Feature: The app's areas as a clickable preview
  The main menu has four areas by the rider's intent: Today (the main screen), Ride, Training and
  Events (docs/ideas/main-menu-structure.md). Search, the device status, Settings, the garage and
  the profile (Me) are global actions in the top bar. Every area and every global screen is a
  plugin of its own: an area is shown beside the menu in the main screen's content area, a global
  screen in a dialog over the page that is shown, so it leaves the navigation as it is (ADR 0058,
  ADR 0071). In this early alpha most of their content is a placeholder, marked "Preview" so that
  nobody takes it for a working feature (ADR 0059).

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-devices, ui-area-ride, ui-area-training, ui-area-events, ui-area-me, ui-garage, ui-search, ui-settings" together with a test device plugin "test-device"
    And the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown

  Scenario: The menu offers the four areas
    Then the menu offers "Today, Ride, Training, Events" in this order
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

  Scenario: Training opens under a big picture that credits its photographer
    When I press "Training"
    Then the "training" screen is shown
    And the screen shows the picture "pictures/hero.jpg" across the top
    And the screen shows the heading "Training" over the picture
    And the picture's credits read "Photo: Munbaik Cycling Clothing, Unsplash"

  Scenario: The top bar offers the global actions
    Then the top bar offers "Search, Devices, Settings, Garage, Profile" in this order

  Scenario Outline: A global action opens its screen in a dialog over the page, and Back closes it
    When I press "Ride"
    And I press "<action>"
    Then the "<screen>" screen is shown in a dialog over the "ride" screen
    And the menu entry "Ride" is the current page
    When I press Back
    Then the "ride" screen is shown
    And no dialog is shown
    And the menu entry "Ride" is the current page

    Examples:
      | action   | screen   |
      | Search   | search   |
      | Devices  | setup    |
      | Settings | settings |
      | Garage   | garage   |
      | Profile  | me       |

  Scenario: Close closes the dialog and keeps the page
    When I press "Training"
    And I press "Settings"
    And I press "Close"
    Then the "training" screen is shown
    And no dialog is shown

  Scenario: A global action over Today keeps the tiles beneath the dialog
    When I press "Profile"
    Then the "me" screen is shown in a dialog over the "main" screen
    And the menu entry "Today" is the current page
    And the tile "ui-tile-ride-start/ride-start" is shown on the main screen

  Scenario: An area chosen in a dialog closes it
    When I press "Search"
    And I type "alp" into "Search"
    And I press "Alpine Loop"
    Then the "ride" screen is shown
    And no dialog is shown
    And the menu entry "Ride" is the current page

  Scenario: The arrows stay in the dialog, and Back gives the focus back to its action
    When I move the focus to "Settings"
    And I press Enter
    Then the "settings" screen is shown in a dialog over the "main" screen
    When I press the arrow key "Down"
    Then the focus is on "Close"
    When I press the arrow key "Up"
    Then the focus is on "Close"
    When I press the arrow key "Down"
    Then the focus is on "Metric"
    When I press Back
    Then no dialog is shown
    And the focus is on "Settings"

  Scenario: The global actions stay on a narrow screen without the top bar
    Given the main screen is 400 px wide
    Then the top bar is not shown
    And the top bar offers "Search, Devices, Settings, Garage, Profile" in this order

  Scenario: The arrows walk through the menu, then the global actions, then the tiles
    When I press the arrow key "Down"
    Then the focus is on "Today"
    When I press the arrow key "Down"
    And I press the arrow key "Down"
    And I press the arrow key "Down"
    Then the focus is on "Events"
    When I press the arrow key "Down"
    Then the focus is on "Search"
    When I press the arrow key "Down"
    And I press the arrow key "Down"
    And I press the arrow key "Down"
    Then the focus is on "Garage"
    When I press the arrow key "Down"
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
    When I press "Profile"
    Then the page offers no "Save" button
    When I press Back
    And I press "Settings"
    Then the page offers no "Save" button

  Scenario: The areas do not know each other or the main screen
    Then the manifest and the client of "ui-area-ride" mention none of "ui-main-screen, ui-area-training, ui-area-events, ui-area-me, ui-search"
    And the manifest and the client of "ui-search" mention none of "ui-main-screen, ui-area-ride, ui-area-training, ui-area-events, ui-area-me"
