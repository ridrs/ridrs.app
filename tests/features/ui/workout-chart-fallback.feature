@ui @workout
Feature: Without the chart plugin a consumer shows its own text
  A consumer of `ui.workout-chart` (ADR 0083) never depends on the chart: while the plugin that
  provides it is not started, the place of the chart holds the consumer's plain text, such as
  "65 min · TSS 72".

  Scenario: The consumer shows its fallback
    Given the ridrs plugins "activity-session, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start" together with the workout chart fixture
    And the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Chart fixture"
    Then the consumer shows the fallback "65 min · TSS 72"
    And the workout chart is not drawn
