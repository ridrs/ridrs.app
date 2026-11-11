@ui @training
Feature: Exporting a workout
  The export screen (`ui.workout-export`, a workbench screen, ADR 0080) offers the six formats
  (ZWO, FIT, ERG, MRC, TCX, intervals.icu text) for one library workout and shows, per format, what
  is converted or lost as warnings before anything is saved (structured-workouts.md, section 9).
  "Save" goes through `files.save` with the right file name and media type; an export that needs
  an FTP the rider has not set is refused and says why. English and German (ADR 0072).

  Here a fixture host lists the fixture library and opens the export of a workout with Enter, and a
  fixture of `files.save` stands in for the native save dialog: it keeps what it was asked to save.

  Background:
    Given the ridrs plugins "ui-settings, profile-local, ui-workout-export" with the workout export fixtures

  Scenario: The six formats are offered and a workout in % FTP is saved as ZWO through files.save
    Given the athlete profile on this device holds an FTP of 250 W and a weight of 72 kg
    And the host has started
    And the ridrs UI is shown
    When I move the focus to "Sweet Spot 3x12"
    And I press Enter
    Then the workout export offers the formats "ZWO (Zwift), FIT (Garmin), ERG, MRC, TCX (Garmin), intervals.icu text"
    And the workout export shows no warnings
    And the workout export names the file "sweet-spot-3x12.zwo"
    When I save the workout export
    Then files.save was asked to save "sweet-spot-3x12.zwo" as "application/xml" with a file starting with "<workout_file>"
    And the workout export reports "Saved sweet-spot-3x12.zwo."

  Scenario: The warnings of a format are shown before anything is saved
    Given the athlete profile on this device holds an FTP of 250 W and a weight of 72 kg
    And the host has started
    And the ridrs UI is shown
    When I move the focus to "Watts Intervals"
    And I press Enter
    And I choose the workout export format "ZWO (Zwift)"
    Then the workout export screen warns "Watts are converted to % FTP with your FTP."
    And files.save was not asked to save anything
    When I choose the workout export format "FIT (Garmin)"
    Then the workout export shows no warnings
    And the workout export names the file "watts-intervals.fit"

  Scenario: A heart rate step becomes a free ride in ZWO, and the screen says so
    Given the athlete profile on this device holds an FTP of 250 W and a weight of 72 kg
    And the host has started
    And the ridrs UI is shown
    When I move the focus to "Heart Rate Endurance"
    And I press Enter
    Then the workout export screen warns "A target this format cannot hold becomes a free ride."

  Scenario: An export that needs an FTP is refused without one, with its reason
    Given the host has started
    And the ridrs UI is shown
    When I move the focus to "Sweet Spot 3x12"
    And I press Enter
    And I choose the workout export format "ERG"
    Then the workout export is refused and says "Cannot export to ERG"
    And the workout export cannot be saved
    When I choose the workout export format "FIT (Garmin)"
    Then the workout export can be saved

  Scenario: A cancelled save dialog saves nothing and says so
    Given the athlete profile on this device holds an FTP of 250 W and a weight of 72 kg
    And the rider cancels the save dialog
    And the host has started
    And the ridrs UI is shown
    When I move the focus to "Sweet Spot 3x12"
    And I press Enter
    And I save the workout export
    Then the workout export reports "Not saved."

  Scenario: Back closes the export and gives the focus back
    Given the host has started
    And the ridrs UI is shown
    When I move the focus to "Sweet Spot 3x12"
    And I press Enter
    And I press Back
    Then the focus is on "Sweet Spot 3x12"

  Scenario: The export speaks German
    Given the rider speaks German
    And the athlete profile on this device holds an FTP of 250 W and a weight of 72 kg
    And the host has started
    And the ridrs UI is shown
    When I move the focus to "Watts Intervals"
    And I press Enter
    And I choose the workout export format "ZWO (Zwift)"
    Then the workout export screen warns "Watt werden mit deiner FTP in % FTP umgerechnet."
    And the workout export names the file "watts-intervals.zwo"
    When I save the workout export
    Then the workout export reports "watts-intervals.zwo gespeichert."
