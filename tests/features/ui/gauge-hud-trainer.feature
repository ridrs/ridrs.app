@ui
Feature: The gauge HUD shows the gear in the cadence gauge and takes the keys of ERG
  In the app the gauge HUD takes the place of the gear widget and the target power widget (their
  dispatching widget is not started): cadence has no average, so the cadence gauge shows the gear
  in its place at the bottom, only the gear itself ("12", or "1×1" with a bicycle's drivetrain),
  not the chainring and the sprocket. The gear is shown while ERG is off; the gauges show no ERG
  target.

  Keyboard first (AGENTS.md rule 12): the gear in the cadence gauge is a control of its own. While
  it has the focus, Up shifts one gear harder and Down one easier. Without the focus, anywhere on
  the activity screen, + and - shift the gear while ERG is off and change the target power by
  5 W in ERG. The gauges only ask (`drivetrain.shift-requested`, `trainer.erg-requested`).

  Background:
    Given the ridrs plugins "activity-session, metric-cadence, ui-main-screen, ui-tile-ride-start, ui-activity-screen, ui-hud-gauges, ui-widget-target-power, control-erg, control-virtual-gears" together with a test device plugin "test-device"
    And the host has started
    And the ridrs UI is shown
    And I press "Start ride"

  Scenario: The cadence gauge shows the gear in place of an average
    Then eventually the cadence gauge shows the gear "12"
    And the cadence gauge shows no average

  Scenario: The gear stays when the cadence is lost, and the gauge says why
    Given eventually the cadence gauge shows the gear "12"
    And "test-device" published a cadence measurement of 90 rpm from device "trainer-1"
    When "test-device" reports device "trainer-1" as "reconnecting"
    Then the cadence gauge is unavailable with the reason "disconnected"
    And the cadence gauge shows the gear "12"

  Scenario: In ERG the gear is not shown
    Given eventually the cadence gauge shows the gear "12"
    And I move the focus to "ERG"
    When I press Enter
    Then eventually the ERG target power is 150 W
    And the cadence gauge shows no gear
    And the power gauge draws no ERG target
    When I press Enter
    Then eventually the cadence gauge shows the gear "12"

  Scenario: Up and Down on the gear shift it
    Given eventually the cadence gauge shows the gear "12"
    And I move the focus to "Gear"
    When I press the arrow key "Up"
    And I press the arrow key "Up"
    Then eventually the cadence gauge shows the gear "14"
    When I press the arrow key "Down"
    Then eventually the cadence gauge shows the gear "13"
    And the focus is on "Gear"

  Scenario: Without ERG, + and - shift the gear without the focus
    Given eventually the cadence gauge shows the gear "12"
    When I press the key "+"
    And I press the key "+"
    And I press the key "-"
    Then eventually the cadence gauge shows the gear "13"

  Scenario: In ERG, + and - change the target power and leave the gear alone
    Given eventually the cadence gauge shows the gear "12"
    And I move the focus to "ERG"
    And I press Enter
    And I move the focus to "Pause"
    When I press the key "+"
    And I press the key "+"
    Then eventually the ERG target power is 160 W
    When I move the focus to "ERG"
    And I press Enter
    Then eventually the cadence gauge shows the gear "12"
