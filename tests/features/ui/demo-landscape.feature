@phase-10 @ui
Feature: The demo landscape draws the road it reports
  The demo landscape alternates 500 m of asphalt and 500 m of gravel, on the course of
  ADR 0027. It draws the road ahead from the presented distance, asphalt and gravel in
  different colours, and what it reports ahead reaches the physics' reader through its
  driver and the spatial layer. A probe stands in for the physics' odometer, so the
  scenario need not ride that far.

  Background:
    Given the ridrs plugins "activity-session, world-driver-ui, spatial-terrain, ui-main-screen, ui-activity-screen, ui-landscape-demo" together with a probe plugin "test-physics" that reads the spatial series "spatial.terrain"
    And the host has started
    And the ridrs UI is shown
    And I press "Start ride"

  Scenario: The start is asphalt as far as the view goes
    Then the landscape draws the road ahead as "asphalt" from 4 m to 160 m only
    And the landscape shows "asphalt" under the rider

  Scenario: Gravel after 500 m, asphalt again after 1 km
    When "test-physics" reports the odometer at 450 m in a "physics.state-batch"
    Then eventually the landscape draws the road ahead as "asphalt" from 454 m to 500 m, then "gravel" to 610 m
    And the landscape draws "asphalt" and "gravel" in different colours
    When "test-physics" reports the odometer at 700 m in a "physics.state-batch"
    Then eventually the landscape shows "gravel" under the rider
    When "test-physics" reports the odometer at 1000.5 m in a "physics.state-batch"
    Then eventually the landscape shows "asphalt" under the rider

  Scenario: What the landscape shows reaches the physics' reader
    When "test-physics" reports the odometer at 3500 m in a "physics.state-batch"
    Then eventually "world-driver-ui" accepted the input "world.terrain-preview" from 3500 m
    And "test-physics" reads at 3500.5 m a gradient of -5 % on "gravel" ("interpolated")
    And "test-physics" reads no terrain at 2000 m, because of "outside-window"
