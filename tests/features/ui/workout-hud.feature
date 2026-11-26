@ui @training
Feature: The workout in the HUD
  During a ride with a workout the HUD shows where the rider is in it (structured-workouts.md,
  section 11a), in a glass panel at the top left, drawn like the gauges: the workout's name, the
  time left in it and the segment the ride is in ("5/10"); below them the segments as a list, each
  a row with its zone ("Z5", in the zone's colour), its length and its target (the ride's workout
  holds watts): the segment just ridden filled in its zone's colour; the current one larger, its
  zone's colour growing from the chip to the right edge as it goes by, the time left in it counting
  down, its length and cadence below; then the next five. The workout's cues show for their
  duration in the middle of the screen, where a pause shows, and not during one; 3-2-1 shows in
  place of the time left before a segment changes. Below the last segment shown, a footer shows
  the workout's intensity ("Intensity 100 %"), which the rider changes with plus and minus; the
  targets of the segments are shown at that intensity, as the trainer holds them. The widget only reads: `activity.state-changed`,
  `activity.athlete`, `workout.step-changed`, `workout.finished`, `workout.intensity-changed`, `workout.halt-changed` and the clock of the frames; it takes no focus. Without a workout it does not
  show.

  Here the scenarios publish those events directly, as the workout player does; the workout is
  5 times (4 minutes at 288 W with 95–105 rpm, 4 minutes at 125 W) for an athlete with an FTP of 250 W.

  Background:
    Given the ridrs plugins "ui-main-screen, ui-activity-screen, ui-hud, ui-widget-workout, ui-settings" for the workout HUD

  Scenario: The HUD shows the segment, its target and the time left in it, filling up as it goes by
    Given the workout HUD is shown
    And a ride with the workout "VO2max 5×4" starts for an athlete with an FTP of 250 W
    When the workout player reports step 5 of the workout
    And 133 seconds go by
    Then the workout HUD shows the name "VO2max 5×4"
    And the workout HUD shows the segment "5/10"
    And the workout HUD shows the time left in the workout "21:47"
    And the workout HUD shows the current segment "Z5 4 min 288 W" with "95–105 rpm"
    And the workout HUD shows the time left "1:47"
    And the workout HUD reads the time left as "1:47 left"
    And the workout HUD shows the bar at 55 %

  Scenario: The HUD sits at the top left, below the window's own buttons
    Given the workout HUD is shown
    And a ride with the workout "VO2max 5×4" starts for an athlete with an FTP of 250 W
    Then the workout HUD sits at the top left, below the window's own buttons

  Scenario: The segments show as a list: the one just ridden, the current one and the next five
    Given the workout HUD is shown
    And a ride with the workout "VO2max 5×4" starts for an athlete with an FTP of 250 W
    When the workout player reports step 5 of the workout
    Then the workout HUD lists the segments
      | state   | zone | length | target |
      | done    | Z1   | 4 min  | 125 W  |
      | current | Z5   | 4 min  | 288 W  |
      | coming  | Z1   | 4 min  | 125 W  |
      | coming  | Z5   | 4 min  | 288 W  |
      | coming  | Z1   | 4 min  | 125 W  |
      | coming  | Z5   | 4 min  | 288 W  |
      | coming  | Z1   | 4 min  | 125 W  |
    And the workout HUD offers nothing to focus

  Scenario: The current segment shows in the colour of its zone
    Given the workout HUD is shown
    And a ride with the workout "VO2max 5×4" starts for an athlete with an FTP of 250 W
    When the workout player reports step 5 of the workout
    Then the workout HUD shows the current step in zone 5
    When the workout player reports step 6 of the workout
    Then the workout HUD shows the current step in zone 1

  Scenario: Without an FTP the HUD shows watts without zones
    Given the workout HUD is shown
    And a ride with the workout "VO2max 5×4" starts for an athlete without an FTP
    When the workout player reports step 5 of the workout
    Then the workout HUD shows the current segment "4 min 288 W" with "95–105 rpm"
    And the workout HUD shows the current step in no zone

  Scenario: A pause holds the step and the ride goes on from there
    Given the workout HUD is shown
    And a ride with the workout "VO2max 5×4" starts for an athlete with an FTP of 250 W
    When the workout player reports step 5 of the workout
    And 60 seconds go by
    And the workout ride is paused
    And 90 seconds go by
    Then the workout HUD shows the time left "3:00"
    When the workout ride goes on
    And 30 seconds go by
    Then the workout HUD shows the time left "2:30"

  Scenario: A cue shows for its duration
    Given the workout HUD is shown
    And a ride with the workout "VO2max 5×4" starts for an athlete with an FTP of 250 W
    When the workout player reports step 5 of the workout
    And 20 seconds go by
    Then the workout HUD shows no note
    When 15 seconds go by
    Then the workout HUD shows the note "Stay seated, spin it out"
    And the note shows in the middle of the screen, outside the workout HUD
    When 15 seconds go by
    Then the workout HUD shows no note

  Scenario: A pause has the middle of the screen to itself
    Given the workout HUD is shown
    And a ride with the workout "VO2max 5×4" starts for an athlete with an FTP of 250 W
    When the workout player reports step 5 of the workout
    And 35 seconds go by
    Then the workout HUD shows the note "Stay seated, spin it out"
    When the workout ride is paused
    Then the workout HUD shows no note
    When the workout ride goes on
    Then the workout HUD shows the note "Stay seated, spin it out"

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
    And the workout HUD shows the current segment "Z1 4 min 125 W"

  Scenario: The workout's intensity shows as a footer below the last segment
    Given the workout HUD is shown
    And a ride with the workout "VO2max 5×4" starts for an athlete with an FTP of 250 W
    When the workout player reports step 5 of the workout
    Then the workout HUD shows "Intensity 100 %" as its footer, below the last segment
    When the workout's intensity changes to 110 %
    Then the workout HUD shows "Intensity 110 %" as its footer, below the last segment
    And the workout HUD shows the current segment "Z6 4 min 317 W" with "95–105 rpm"
    And the workout HUD lists the segments
      | state   | zone | length | target |
      | done    | Z1   | 4 min  | 138 W  |
      | current | Z6   | 4 min  | 317 W  |
      | coming  | Z1   | 4 min  | 138 W  |
      | coming  | Z6   | 4 min  | 317 W  |
      | coming  | Z1   | 4 min  | 138 W  |
      | coming  | Z6   | 4 min  | 317 W  |
      | coming  | Z1   | 4 min  | 138 W  |

  Scenario: The intensity of an earlier ride is not this ride's
    Given the workout HUD is shown
    And the workout's intensity changed to 120 % in an earlier ride
    And a ride with the workout "VO2max 5×4" starts for an athlete with an FTP of 250 W
    When the workout player reports step 5 of the workout
    Then the workout HUD shows "Intensity 100 %" as its footer, below the last segment

  Scenario: Without a workout nothing shows
    Given the workout HUD is shown
    And a ride without a workout starts
    Then the workout HUD is not shown

  Scenario: A step of an earlier ride is not taken for this one
    Given the workout HUD is shown
    And the workout player reported step 5 of the workout in an earlier ride
    When a ride with the workout "VO2max 5×4" starts for an athlete with an FTP of 250 W
    Then the workout HUD shows the segment "0/10"
    And the workout HUD lists the segments
      | state  | zone | length | target |
      | coming | Z5   | 4 min  | 288 W  |
      | coming | Z1   | 4 min  | 125 W  |
      | coming | Z5   | 4 min  | 288 W  |
      | coming | Z1   | 4 min  | 125 W  |
      | coming | Z5   | 4 min  | 288 W  |

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
    Then the workout HUD shows the current segment "Z5 4 Min. 288 W" with "95–105 U/min"
    And the workout HUD reads the time left as "noch 1:47"
    When the workout player reports the workout finished
    Then the workout HUD says "Workout geschafft"

  Scenario: While the workout halts, the step's time stands and the middle of the screen says how to go on
    Given the workout HUD is shown
    And a ride with the workout "VO2max 5×4" starts for an athlete with an FTP of 250 W
    When the workout player reports step 5 of the workout
    And 30 seconds go by
    And the workout player reports the workout "halted"
    And 20 seconds go by
    Then the workout HUD shows the time left "3:30"
    And the workout HUD shows the note "Workout halted · pedal to go on"
    When the workout player reports the workout "countdown 5 waiting"
    Then the workout HUD shows the note "Pedal faster · from 55 rpm"
    When the workout player reports the workout "countdown 3"
    Then the workout HUD shows the note "Going on in 3"
    When the workout player reports the workout "running"
    And 10 seconds go by
    Then the workout HUD shows the time left "3:20"
    And the workout HUD shows the note "Stay seated, spin it out"
