@ui @workout
Feature: The full workout chart, stepped through with the arrow keys
  The workout chart is a UI capability (`ui.workout-chart`, ADR 0083). Its `full` variant draws
  the whole workout: axes, a bracket "3×" over a repeat, the FTP line and a zone bar. Every step
  can take the focus; Left and Right move from step to step, and the tooltip follows the focus
  with the step's duration and target in % FTP and watts (AGENTS.md rule 12: a rider can step
  through a workout on the bicycle before starting it). Enter and Back are left to the app. Without
  an FTP the chart is neutral with a discreet hint. It is described for a screen reader in
  English and German, and a consumer shows its own text where the chart is not there.

  The fixture screen, opened by the menu entry "Chart fixture", draws "Sweet Spot 3x12" (65 minutes: a ramp warm-up, 3 × 12 minutes at 90 %
  with 4 minutes at 55 % between, a ramp cool-down) for an FTP of 250 W.

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-settings, ui-workout-chart" together with the workout chart fixture
    And the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown

  Scenario: The full chart draws every step with a bracket, a zone bar and the FTP line
    When I press "Chart fixture"
    Then the workout chart draws 8 steps
    And the workout chart has the bracket "3×"
    And the workout chart has a zone bar and an FTP line

  Scenario: Left and Right step through the steps and the tooltip follows
    When I press "Chart fixture"
    And the focus is put on the first step of the workout chart
    Then the workout chart tooltip shows:
      | title    | Warm-up                 |
      | duration | 12 min                  |
      | target   | 50–75 % FTP · 125–188 W |
    And the consumer says "Focused warm"
    When I press the arrow key "Right"
    Then the workout chart tooltip shows:
      | title    | Interval         |
      | duration | 12 min           |
      | target   | 90 % FTP · 225 W |
      | zone     | Zone 3 · Tempo   |
    And the consumer says "Focused on"
    When I press the arrow key "Left"
    Then the consumer says "Focused warm"
    When I press the arrow key "Left"
    Then the consumer says "Focused warm"

  Scenario: The chart keeps the focus at its last step
    When I press "Chart fixture"
    And the focus is put on the first step of the workout chart
    And I press the arrow key "Right" 7 times in the workout chart
    Then the consumer says "Focused cool"
    When I press the arrow key "Right"
    Then the consumer says "Focused cool"

  Scenario: The chart is one focus stop with a roving step focus
    When I press "Chart fixture"
    Then exactly 1 step of the workout chart is tabbable
    When the focus is put on the first step of the workout chart
    And I press the arrow key "Right"
    Then exactly 1 step of the workout chart is tabbable
    And the tabbable step of the workout chart is step 2
    And Down leaves the workout chart for the next control

  Scenario: Hovering a step shows its tooltip as well
    When I press "Chart fixture"
    And the pointer is over step 3 of the workout chart
    Then the workout chart tooltip shows:
      | title    | Rest            |
      | duration | 4 min           |
      | target   | 55 % FTP · 138 W |

  Scenario: Enter and Back are not swallowed by the chart
    When I press "Chart fixture"
    And the focus is put on the first step of the workout chart
    Then Enter and Back pressed on the focused step reach the app unhandled

  Scenario: Without an FTP the chart is neutral with a hint
    When I press "Chart fixture"
    And I press "Remove the FTP"
    Then the workout chart is neutral
    And the workout chart hint says "Set your FTP to see the zones"
    And the workout chart has no zone bar
    When I press "Give an FTP"
    Then the workout chart is coloured by zone
    And the workout chart has no hint

  Scenario: The chart is described in English
    When I press "Chart fixture"
    Then the workout chart is described as "65 minutes, 3 intervals of 12 minutes at 90 %"

  Scenario: The chart is described in German
    When I press "Settings"
    And I press "Deutsch"
    And I press "Schließen"
    And I press "Chart fixture"
    Then the workout chart is described as "65 Minuten, 3 Intervalle à 12 Minuten bei 90 %"
