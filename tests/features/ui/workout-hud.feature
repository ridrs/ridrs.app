@ui @training
Feature: The workout in the HUD
  During a ride with a workout the HUD shows where the rider is in it (structured-workouts.md,
  section 11a): the workout's name, the set ("3/5"), the current step with its target in % and W
  (the ride's workout holds watts; % beside them when the ride's athlete has an FTP) and its
  cadence, the time left in the step with a bar, the next step, a small chart with a progress
  mark (`ui.workout-chart`, variant `hud`), the workout's cues for their duration and 3-2-1
  before a step changes. The widget only reads: `activity.state-changed`, `activity.athlete`,
  `workout.step-changed`, `workout.finished` and the clock of the frames; it takes no focus.
  Without a workout it does not show.

  Here the scenarios publish those events directly, as the workout player does; the workout is
  5 times (4 minutes at 288 W with 95–105 rpm, 4 minutes at 125 W) for an athlete with an FTP of 250 W.

  Background:
    Given the ridrs plugins "ui-main-screen, ui-activity-screen, ui-hud, ui-widget-workout, ui-workout-chart, ui-settings" for the workout HUD

  Scenario: The HUD shows the step, its target, the time left and the next step
    Given the workout HUD is shown
    And a ride with the workout "VO2max 5×4" starts for an athlete with an FTP of 250 W
    When the workout player reports step 5 of the workout
    And 133 seconds go by
    Then the workout HUD shows the name "VO2max 5×4"
    And the workout HUD shows the set "3/5"
    And the workout HUD shows the current step "NOW 4:00 at 115 % 288 W 95–105 rpm"
    And the workout HUD shows the time left "1:47 left"
    And the workout HUD shows the bar at 55 %
    And the workout HUD shows the next step "NEXT 4:00 at 50 % 125 W"

  Scenario: Without an FTP the HUD shows watts only
    Given the workout HUD is shown
    And a ride with the workout "VO2max 5×4" starts for an athlete without an FTP
    When the workout player reports step 5 of the workout
    Then the workout HUD shows the current step "NOW 4:00 at 288 W 95–105 rpm"
    And the workout HUD shows the next step "NEXT 4:00 at 125 W"

  Scenario: The progress mark of the chart moves with the ride's time
    Given the workout HUD is shown
    And a ride with the workout "VO2max 5×4" starts for an athlete with an FTP of 250 W
    When the workout player reports step 5 of the workout
    And 133 seconds go by
    Then the chart of the workout HUD is the variant "hud" with its mark at 1093 seconds
    And the chart of the workout HUD highlights the step "work" at 960 seconds
    When 20 seconds go by
    Then the chart of the workout HUD is the variant "hud" with its mark at 1113 seconds
    And the workout HUD offers nothing to focus

  Scenario: A pause holds the step and the ride goes on from there
    Given the workout HUD is shown
    And a ride with the workout "VO2max 5×4" starts for an athlete with an FTP of 250 W
    When the workout player reports step 5 of the workout
    And 60 seconds go by
    And the workout ride is paused
    And 90 seconds go by
    Then the workout HUD shows the time left "3:00 left"
    When the workout ride goes on
    And 30 seconds go by
    Then the workout HUD shows the time left "2:30 left"

  Scenario: A cue shows for its duration
    Given the workout HUD is shown
    And a ride with the workout "VO2max 5×4" starts for an athlete with an FTP of 250 W
    When the workout player reports step 5 of the workout
    And 20 seconds go by
    Then the workout HUD shows no note
    When 15 seconds go by
    Then the workout HUD shows the note "Stay seated, spin it out"
    When 15 seconds go by
    Then the workout HUD shows no note

  Scenario: 3-2-1 before the step changes
    Given the workout HUD is shown
    And a ride with the workout "VO2max 5×4" starts for an athlete with an FTP of 250 W
    When the workout player reports step 5 of the workout
    And 236 seconds go by
    Then the workout HUD counts nothing down
    When 1 second goes by
    Then the workout HUD counts down "3"
    When 1 second goes by
    Then the workout HUD counts down "2"
    When 1 second goes by
    Then the workout HUD counts down "1"
    When the workout player reports step 6 of the workout
    Then the workout HUD counts nothing down
    And the workout HUD shows the current step "NOW 4:00 at 50 % 125 W"

  Scenario: Without a workout nothing shows
    Given the workout HUD is shown
    And a ride without a workout starts
    Then the workout HUD is not shown

  Scenario: A step of an earlier ride is not taken for this one
    Given the workout HUD is shown
    And the workout player reported step 5 of the workout in an earlier ride
    When a ride with the workout "VO2max 5×4" starts for an athlete with an FTP of 250 W
    Then the workout HUD shows the next step "NEXT 4:00 at 115 % 288 W"

  Scenario: After the workout it says so
    Given the workout HUD is shown
    And a ride with the workout "VO2max 5×4" starts for an athlete with an FTP of 250 W
    When the workout player reports step 10 of the workout
    And the workout player reports the workout finished
    Then the workout HUD says "Workout done"
    And the workout HUD shows the name "VO2max 5×4"

  Scenario: In German
    Given the rider speaks German
    And the workout HUD is shown
    And a ride with the workout "VO2max 5×4" starts for an athlete with an FTP of 250 W
    When the workout player reports step 5 of the workout
    And 133 seconds go by
    Then the workout HUD shows the current step "JETZT 4:00 bei 115 % 288 W 95–105 U/min"
    And the workout HUD shows the time left "noch 1:47"
    And the workout HUD shows the next step "DANACH 4:00 bei 50 % 125 W"
    When the workout player reports the workout finished
    Then the workout HUD says "Workout geschafft"
