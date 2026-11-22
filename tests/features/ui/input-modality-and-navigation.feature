@ui
Feature: Unified input modality, 2D spatial navigation, and fullscreen cursor auto-hide
  A rider switches effortlessly between mouse, keyboard and controller (AGENTS.md rule 12).
  The shell detects the active input mode automatically: real pointer movement enters pointer mode
  (hover highlight), while keyboard or controller navigation enters keyboard mode (focus highlight).
  Both modes use one unified highlight style across all controls, including all four round controls
  on the activity screen. In fullscreen, the pointer cursor hides after a short timeout without
  movement and reappears on movement or when leaving fullscreen. Arrow navigation moves in two
  dimensions by visual position and stays stable when controls appear, disappear or disable.

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-tile-ride-start, ui-activity-screen, ui-widget-target-power, control-erg, ui-ride-screenshot, ui-settings" together with a test device plugin "test-device"
    And the host has started
    And the ridrs UI is shown

  Scenario: Modality switches automatically between pointer, keyboard and controller
    When I move the pointer to 100, 100
    And I move the pointer to 140, 100
    Then the input mode is "pointer"
    When I press the arrow key "Down"
    Then the input mode is "keyboard"
    When I move the pointer to 140, 100
    Then the input mode is "keyboard"
    When I move the pointer to 200, 140
    Then the input mode is "pointer"
    When the controller presses "down"
    Then the input mode is "keyboard"

  Scenario: Fullscreen hides the pointer cursor after inactivity and restores it on movement or exit
    Given the window is in fullscreen
    When I move the pointer to 120, 120
    And I move the pointer to 160, 120
    Then the pointer cursor is visible
    When the cursor inactivity timeout elapses
    Then the pointer cursor is hidden
    When I move the pointer to 220, 160
    Then the pointer cursor is visible
    When I press the arrow key "Down"
    Then the pointer cursor is hidden
    When the window leaves fullscreen
    Then the pointer cursor is visible

  Scenario: All four round activity controls share the unified highlight style
    Given I press "Start ride"
    Then the ride's buttons "Pause, ERG, Screenshot, Finish ride" are round and side by side at the bottom right
    And all four ride controls "Pause, ERG, Screenshot, Finish ride" use the unified highlight without inline outline overrides

  Scenario: Arrow keys navigate in two dimensions across the activity screen controls
    Given I press "Start ride"
    And the visible controls are laid out in 2D:
      | name        | left | top | width | height |
      | Pause       | 1000 | 700 | 56    | 56     |
      | ERG         | 1072 | 700 | 56    | 56     |
      | Screenshot  | 1144 | 700 | 56    | 56     |
      | Finish ride | 1216 | 700 | 56    | 56     |
    When I press the arrow key "Down"
    Then the focus is on "Pause"
    When I press the arrow key "Right"
    Then the focus is on "ERG"
    When I press the arrow key "Right"
    Then the focus is on "Screenshot"
    When I press the arrow key "Down"
    Then the focus is on "Screenshot"
    When I press the arrow key "Left"
    Then the focus is on "ERG"

  Scenario: Disabling or removing a focused button does not reset navigation to the top
    Given I press "Start ride"
    And the visible controls are laid out in 2D:
      | name        | left | top | width | height |
      | Pause       | 1000 | 700 | 56    | 56     |
      | ERG         | 1072 | 700 | 56    | 56     |
      | Screenshot  | 1144 | 700 | 56    | 56     |
      | Finish ride | 1216 | 700 | 56    | 56     |
    When I move the focus to "ERG"
    And the control "ERG" becomes disabled
    And I press the arrow key "Right"
    Then the focus is on "Screenshot"
