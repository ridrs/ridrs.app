@phase-8 @ui
Feature: A debug HUD of the trainer's control during a ride
  To tune the trainer's feel, the activity screen shows what ridrs tells the trainer: whether it
  controls it and in which mode, the last command it sent (the ERG target, or the simulation
  parameters: gradient, rolling resistance, wind resistance, wind speed), the virtual gear, and
  the gradient of the road next to the gradient the trainer simulates with the virtual gear. It
  only reads events; it never takes the focus, so it changes no ride control. The key D hides
  and shows it.

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-tile-ride-start, ui-activity-screen, ui-hud, ui-debug-trainer, control-virtual-gears" together with a test device plugin "test-device"
    And the host has started
    And the ridrs UI is shown
    And I press "Start ride"

  Scenario: Without a trainer the debug HUD shows dashes
    Then the trainer debug HUD shows "Mode" "–"
    And the trainer debug HUD shows "Command" "–"

  Scenario: The debug HUD shows the control and the mode
    When "test-device" reported the control "granted" of its trainer in the mode "simulation"
    Then the trainer debug HUD shows "Mode" "simulation (granted)"

  Scenario: The debug HUD shows the ERG target
    When "test-device" reported the control "granted" of its trainer in the mode "erg"
    And "test-device" sent its trainer the target power 150 W
    Then the trainer debug HUD shows "Mode" "ERG 150 W (granted)"
    And the trainer debug HUD shows "Command" "target 150 W"

  Scenario: The debug HUD shows the simulation parameters sent last
    When "test-device" sent its trainer the simulation gradient 0.045, crr 0.004, cw 0.51 and wind 0
    Then the trainer debug HUD shows "Command" "grade 4.50 % · Crr 0.0040 · CW 0.510 kg/m · wind 0.0 m/s"

  Scenario: The debug HUD shows the virtual gear
    Then eventually the trainer debug HUD shows "Gear" "12 / 24 · ratio 2.12"

  Scenario: The debug HUD shows the road's gradient and the one the trainer simulates
    When the physics reports a road gradient of 0.03 and a trainer gradient of 0.045 in gear 12
    Then the trainer debug HUD shows "Gradient" "road 3.00 % → trainer 4.50 %"

  Scenario: The debug HUD never takes the focus
    Then the trainer debug HUD has nothing focusable

  Scenario: D hides and shows the debug HUD
    When I press the key "d"
    Then the trainer debug HUD is not shown
    When I press the key "d"
    Then the trainer debug HUD shows "Command" "–"
