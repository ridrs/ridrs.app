@ui
Feature: The buttons of the controller, and where to change them
  A rider on the trainer uses the app with the controller on the handlebar (AGENTS.md rule 12,
  ADR 0098). The shell turns its buttons into the keys every screen understands: by default the
  d-pad of a Zwift Ride is the arrow keys, A is Enter and B is Back. The settings have a tab
  "Controller" that shows, as games do, which button each command is on: choosing a command
  waits for the next button pressed on the controller and puts the command on it. A command that
  had that button gets the old one in exchange, so no command is ever without a button. The
  shift and power-up buttons keep their ride functions and are listed as fixed. The bindings take
  effect at once and are kept when ridrs restarts.

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-devices, ui-area-ride, ui-route-profile, ui-area-training, ui-area-events, ui-area-me, ui-garage, ui-search, ui-settings" together with a test device plugin "test-device"
    And the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown

  Scenario: The d-pad moves the focus, A activates and B goes back
    When the controller presses "down"
    Then the focus is on "Today"
    When the controller presses "down"
    Then the focus is on "Ride"
    When the controller presses "up"
    Then the focus is on "Today"
    When I move the focus to "Settings"
    When the controller presses "a"
    Then the screen shows the heading "Settings"
    When the controller presses "b"
    Then the screen shows no heading "Settings"

  Scenario: The settings have a tab for the controller with its default buttons
    When I press "Settings"
    Then the settings offer the tabs "General, Controller"
    When I open the tab "Controller"
    Then the controller bindings are:
      | command         | button |
      | Up              | Up     |
      | Down            | Down   |
      | Left            | Left   |
      | Right           | Right  |
      | Confirm (Enter) | A      |
      | Back (Escape)   | B      |
    And the fixed controller buttons are "Shift harder, Shift easier, ERG target: lower (left), raise (right)"

  Scenario: A command goes on the next button pressed, as in a game
    When I press "Settings"
    And I open the tab "Controller"
    And I choose the binding of "Confirm (Enter)"
    Then the binding of "Confirm (Enter)" waits for a button
    When the controller presses "y"
    Then the binding of "Confirm (Enter)" is "Y"
    And the settings say "Confirm (Enter) is on Y now."
    And the screen shows the heading "Settings"

  Scenario: A button already in use is swapped
    When I press "Settings"
    And I open the tab "Controller"
    And I choose the binding of "Confirm (Enter)"
    And the controller presses "b"
    Then the binding of "Confirm (Enter)" is "B"
    And the binding of "Back (Escape)" is "A"
    And the settings say "Confirm (Enter) is on B now; Back (Escape) moved to A."
    When the controller presses "a"
    Then the screen shows no heading "Settings"

  Scenario: The shift and power-up buttons cannot be taken
    When I press "Settings"
    And I open the tab "Controller"
    And I choose the binding of "Back (Escape)"
    And the controller presses "shift-up-right"
    Then the binding of "Back (Escape)" waits for a button
    And the settings say "+ keeps its ride function. Press another button."

  Scenario: Back cancels the waiting and keeps the settings open
    When I press "Settings"
    And I open the tab "Controller"
    And I choose the binding of "Up"
    And I press Back
    Then the binding of "Up" is "Up"
    And the screen shows the heading "Settings"

  Scenario: The bindings are kept when ridrs restarts, and Reset gives the defaults back
    When I press "Settings"
    And I open the tab "Controller"
    And I choose the binding of "Back (Escape)"
    And the controller presses "z"
    And ridrs restarted
    And I reload the UI
    And I press "Settings"
    And I open the tab "Controller"
    Then the binding of "Back (Escape)" is "Z"
    And the user settings hold the file "config/user/ui-settings/controller.json"
    When I press "Reset to defaults"
    Then the binding of "Back (Escape)" is "B"
    And the settings say "The controller has its default buttons again."
