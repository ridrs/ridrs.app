@phase-8 @ui
Feature: ERG and virtual gears with the keyboard alone
  During a ride the rider controls the trainer with the keyboard or a remote (AGENTS.md rule 12),
  until keys can be mapped in settings. The ERG button in the HUD is a pure toggle: Enter turns
  ERG on (at the default target) and off, and it says "On" or "Off". One place in the HUD shows
  either the gear or the target power: a dispatching widget shows the gear while ERG is off and
  the target power while it is on, without knowing either widget. While the target power has the
  focus, Up and Down change it by 5 W; while the gear has it, Up shifts one gear harder and Down
  one gear easier. On both, Left and Right still move the focus, and while one of them has the
  focus it shows the keys it takes. Without the focus, anywhere on the activity screen, + and -
  change the target power in ERG and shift the gear otherwise. The first arrow of a ride focuses
  Pause, not a control that changes the ride.

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-tile-ride-start, ui-activity-screen, ui-hud, ui-widget-virtual-gear, ui-widget-target-power, ui-widget-erg-dispatch, control-erg, control-virtual-gears" together with a test device plugin "test-device"
    And the host has started
    And the ridrs UI is shown
    And I press "Start ride"
    And eventually the virtual gear widget shows "12"

  Scenario: The first arrow of a ride focuses Pause
    When I press the arrow key "Down"
    Then the focus is on "Pause"

  Scenario: Enter on the ERG button turns ERG on and off, and it says only On or Off
    Given I move the focus to "ERG"
    And the ERG button is off
    When I press Enter
    Then the ERG button is on
    And the focus is on "ERG"
    When I press Enter
    Then the ERG button is off
    And the focus is on "ERG"

  Scenario: In ERG the target power takes the place of the gear, and the gear comes back after it
    Given I move the focus to "ERG"
    When I press Enter
    Then eventually the target power widget shows "150 W"
    And the virtual gear widget is not shown
    When I press Enter
    Then eventually the virtual gear widget shows "12"
    And the target power widget is not shown

  Scenario: In ERG, Up and Down on the target power change it by 5 W
    Given I move the focus to "ERG"
    And I press Enter
    And I move the focus to "Target power"
    When I press the arrow key "Up"
    And I press the arrow key "Up"
    And I press the arrow key "Down"
    Then eventually the target power widget shows "155 W"
    And the focus is on "Target power"
    And the focused control shows the keys "↑ ↓ target"
    And the ERG button is on

  Scenario: Back on the target power leaves ERG
    Given I move the focus to "ERG"
    And I press Enter
    And I move the focus to "Target power"
    When I press Back
    Then the ERG button is off
    And eventually the virtual gear widget shows "12"

  Scenario: Up and Down on the ERG button move the focus, with and without ERG
    Given I move the focus to "ERG"
    When I press the arrow key "Up"
    Then the focus is on "Gear"
    And the ERG button is off
    When I move the focus to "ERG"
    And I press Enter
    And I press the arrow key "Up"
    Then the focus is on "Target power"
    And the ERG button is on
    And eventually the target power widget shows "150 W"

  Scenario: Left and Right move the focus from the ERG button in ERG
    Given I move the focus to "ERG"
    And I press Enter
    When I press the arrow key "Left"
    Then the focus is on "Target power"
    When I press the arrow key "Right"
    Then the focus is on "ERG"
    And eventually the target power widget shows "150 W"

  Scenario: Up and Down on the gear shift it
    Given I move the focus to "Gear"
    When I press the arrow key "Up"
    And I press the arrow key "Up"
    Then eventually the virtual gear widget shows "14"
    When I press the arrow key "Down"
    Then eventually the virtual gear widget shows "13"
    And the focus is on "Gear"
    And the focused control shows the keys "↑ ↓ shift"

  Scenario: Left and Right move the focus from the gear
    Given I move the focus to "Gear"
    When I press the arrow key "Right"
    Then the focus is on "ERG"
    When I press the arrow key "Left"
    Then the focus is on "Gear"
    And the virtual gear widget shows "12"

  Scenario: Without ERG, + and - shift the gear without the focus
    When I press the key "+"
    And I press the key "+"
    And I press the key "-"
    Then eventually the virtual gear widget shows "13"

  Scenario: In ERG, + and - change the target power, not the gear
    Given I move the focus to "ERG"
    And I press Enter
    And I move the focus to "Pause"
    When I press the key "+"
    And I press the key "+"
    And I press the key "-"
    Then eventually the target power widget shows "155 W"
    When I move the focus to "ERG"
    And I press Enter
    Then eventually the virtual gear widget shows "12"
