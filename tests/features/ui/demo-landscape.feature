@phase-10 @ui
Feature: The demo landscape draws the road it reports
  The demo landscape is 3 km of asphalt, then 1 km of gravel, repeating, on the course of
  ADR 0027. It draws the road ahead from the presented distance, asphalt and gravel in
  different colours, and what it reports ahead reaches the physics' reader through its
  driver and the spatial layer. A probe stands in for the physics' odometer, so the
  scenario need not ride 3 km.

  Background:
    Given the ridrs plugins "activity-session, world-driver-ui, spatial-terrain, ui-main-screen, ui-activity-screen, ui-landscape-demo" together with a probe plugin "test-physics" that reads the spatial series "spatial.terrain"
    And the host has started
    And the ridrs UI is shown
    And I press "Start ride"

  Scenario: The start is asphalt as far as the view goes
    Then the landscape draws the road ahead as "asphalt" from 4 m to 160 m only
    And the landscape shows "asphalt" under the rider

  Scenario: Gravel after 3 km, asphalt again after 4 km
    When "test-physics" reports the odometer at 2950 m in a "physics.state-batch"
    Then eventually the landscape draws the road ahead as "asphalt" from 2954 m to 3000 m, then "gravel" to 3110 m
    And the landscape draws "asphalt" and "gravel" in different colours
    When "test-physics" reports the odometer at 3500 m in a "physics.state-batch"
    Then eventually the landscape shows "gravel" under the rider
    When "test-physics" reports the odometer at 4000.5 m in a "physics.state-batch"
    Then eventually the landscape shows "asphalt" under the rider

  Scenario: What the landscape shows reaches the physics' reader
    When "test-physics" reports the odometer at 3500 m in a "physics.state-batch"
    Then eventually "world-driver-ui" accepted the input "world.terrain-preview" from 3500 m
    And "test-physics" reads at 3500.5 m a gradient of -5 % on "gravel" ("interpolated")
    And "test-physics" reads no terrain at 2000 m, because of "outside-window"
