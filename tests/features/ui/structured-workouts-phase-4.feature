@ui @training
Feature: An imported workout, edited, planned and ridden from Today, by keyboard
  The vertical use case of phase 4 of structured workouts (structured-workouts.md, section 13),
  through the real plugins and no stand-in for a domain plugin: the rider imports a ZWO file in
  the Training area, opens the imported workout's details, edits one interval in the editor and
  saves, plans the workout on today in the Training area, and Today shows it as the next workout
  with its chart and the changed power. From there on only the arrow keys, Enter and Back are
  used: they reach the planned workout, Enter opens its details, the arrows reach the changed
  interval and Back returns to where the details were opened (ADR 0080).

  Here the planned workouts are those of ridrs on this device; no intervals.icu is involved. It is
  Wednesday 4 November 2026.

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-settings, ui-area-training, library-ridrs, profile-local, ui-training-plan, ui-workout-import, ui-workout-editor, ui-workout-chart, ui-workout-details" with app files and a test device plugin "test-device"
    And the local time is "2026-11-04 08:00"
    And the athlete profile on this device holds an FTP of 250 W and a weight of 72 kg
    And the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown

  Scenario: Import a ZWO file, change an interval, plan it and step through it from Today
    When I press "Training"
    And I press "Import workouts"
    And I choose the file "sweet-spot-3x12.zwo"
    And I press "Import"
    Then the import says "Imported 1 workout."
    When I press Back
    And I open the details of the library workout "Sweet Spot 3x12"
    And I press "Edit" in the details of the workout
    And I set "power-value" of step 6 in the workout editor to "100"
    And I save the workout in the workout editor
    Then the details of the workout show the name "Sweet Spot 3x12"
    When I press Back
    And I drag the workout "Sweet Spot 3x12" onto "Wednesday"
    And I press Back
    Then the next workout card shows:
      | day  | Today           |
      | name | Sweet Spot 3x12 |
    And the chart of the next workout draws the step "6" higher than the step "4"
    When I move the focus to "Training"
    And I press Enter
    And I move the focus to "Sweet Spot 3x12"
    And I press Enter
    Then the details of the workout show the name "Sweet Spot 3x12"
    And the details of the workout show "Planned for Wed 4 Nov"
    When I move the focus to the chart in the details of the workout
    And I press the arrow key "Right" 5 times
    Then the workout chart in the details has the step "6" selected
    And the selected step of the details of the workout has the target "100 % FTP · 250 W · 85 rpm"
    When I move the focus to the first step of the details of the workout
    And I press the arrow key "Down" 5 times
    Then the focused step of the details of the workout has the target "100 % FTP · 250 W · 85 rpm"
    And the selected step of the details of the workout has the target "100 % FTP · 250 W · 85 rpm"
    When I press Back
    Then no details of a workout are shown
    And the focus is on the planned workout "Sweet Spot 3x12"
