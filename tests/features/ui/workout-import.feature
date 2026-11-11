@ui @training
Feature: Importing workouts from files, a ZIP or pasted text
  The screen `workout-import` opens in a dialog over the page (ADR 0071). The rider chooses files
  or drops them (a ZIP is unpacked), or pastes an intervals.icu text. Each workout gets a preview
  row: a small chart (`ui.workout-chart`, variant `mini`), its name and duration, and a state:
  ✓, ⚠ with a note, or ✗ with its reason in plain words. Nothing is converted: the notes only
  explain. A workout that is in the library already (the same file content) is a duplicate: skip
  it or import it as a copy. Running, swimming and strength workouts are refused. "Import" saves
  the accepted ones in the library "ridrs" with their original file. Off the ride path, a pointer
  is enough (ADR 0080).

  Here a fixture host page opens the screen, a fixture chart stands in for `ui-workout-chart`, and
  the files are those of tests/fixtures/workout-import/.

  Background:
    Given the ridrs plugins "ui-settings, library-ridrs, ui-workout-import" with the workout import fixtures
    And the fixture chart of workouts is installed

  Scenario: A ZWO file gets a preview with a chart and is imported with its original
    Given the host has started
    And the ridrs UI is shown
    When I press "Open the workout import"
    And I choose the file "sweet-spot-3x12.zwo"
    Then the preview lists these workouts:
      | file                | name            | duration  | state |
      | sweet-spot-3x12.zwo | Sweet Spot 3x12 | 1 h 2 min | ✓     |
    And the preview of "sweet-spot-3x12.zwo" draws a chart of "Sweet Spot 3x12" in the variant "mini"
    And the preview of "sweet-spot-3x12.zwo" notes "Targets in % FTP, resolved with your FTP when the ride starts."
    When I press "Import"
    Then the import says "Imported 1 workout."
    And the library "ridrs" holds 6 workouts
    And the library "ridrs" holds the workout "Sweet Spot 3x12" from the file "sweet-spot-3x12.zwo" under an id of its file name and the start of its hash
    And the original of the imported "Sweet Spot 3x12" is kept as an app file named by its SHA-256
    When the host restarts
    Then the library "ridrs" holds 6 workouts

  Scenario: A ZIP is unpacked and every workout in it gets a row
    Given the host has started
    And the ridrs UI is shown
    When I press "Open the workout import"
    And I drop the file "three-workouts.zip"
    Then the preview lists these workouts:
      | file                   | name                                | duration    | state |
      | intervals-free-max.zwo | Intervals, free ride and max effort | 30 min 20 s | ⚠     |
      | threshold-2x10.erg     | Threshold 2x10                      | 40 min 30 s | ✓     |
      | over-unders.mrc        | over-unders                         | 26 min 30 s | ✓     |
    When I press "Import"
    Then the import says "Imported 3 workouts."
    And the library "ridrs" holds 8 workouts

  Scenario: A FIT workout in watts says it is ridden in watts
    Given the host has started
    And the ridrs UI is shown
    When I press "Open the workout import"
    And I choose the file "watts-3x10.fit"
    Then the preview of "watts-3x10.fit" has the state "✓"
    And the preview of "watts-3x10.fit" notes "Targets in watts, ridden in watts."

  Scenario: Steps by heart rate are noted as not ridden with ERG
    Given the host has started
    And the ridrs UI is shown
    When I press "Open the workout import"
    And I paste the intervals.icu text of "zones-and-heart-rate.txt" as "Heart rate mix"
    Then the preview of "Heart rate mix.txt" has the state "⚠"
    And the preview of "Heart rate mix.txt" notes "5 steps by heart rate, no ERG."
    And the preview of "Heart rate mix.txt" notes "Targets in watts, ridden in watts."

  Scenario: A running workout is refused with its note
    Given the host has started
    And the ridrs UI is shown
    When I press "Open the workout import"
    And I choose the file "run-only.tcx"
    Then the preview of "run-only.tcx" has the state "✗"
    And the preview of "run-only.tcx" notes "This is not a cycling workout. ridrs imports cycling workouts only."
    And the import button "Import" is disabled

  Scenario: A broken file shows its reason
    Given the host has started
    And the ridrs UI is shown
    When I press "Open the workout import"
    And I choose the file "broken-unclosed.zwo"
    Then the preview of "broken-unclosed.zwo" has the state "✗"
    And the preview of "broken-unclosed.zwo" notes "The file is damaged: it is not well-formed XML."

  Scenario: The same file again is a duplicate that can be skipped
    Given the host has started
    And the ridrs UI is shown
    When I press "Open the workout import"
    And I choose the file "threshold-2x10.erg"
    And I press "Import"
    Then the import says "Imported 1 workout."
    When I choose the file "threshold-2x10.erg"
    Then the preview of "threshold-2x10.erg" has the state "⚠"
    And the preview of "threshold-2x10.erg" notes "Already in your library as “Threshold 2x10”."
    And the import button "Import" is disabled
    And the library "ridrs" holds 6 workouts

  Scenario: The same file again can be imported as a copy with an id of its own
    Given the host has started
    And the ridrs UI is shown
    When I press "Open the workout import"
    And I choose the file "threshold-2x10.erg"
    And I press "Import"
    Then the import says "Imported 1 workout."
    When I choose the file "threshold-2x10.erg"
    And I choose "Import as a copy" for the duplicate "threshold-2x10.erg"
    And I press "Import"
    Then the import says "Imported 1 workout."
    And the library "ridrs" holds 7 workouts
    And the library "ridrs" holds two workouts named "Threshold 2x10" with different ids

  Scenario: The same file twice in one go is one workout and a duplicate
    Given the host has started
    And the ridrs UI is shown
    When I press "Open the workout import"
    And I choose the files "over-unders.mrc, over-unders.mrc"
    Then the preview of the second "over-unders.mrc" has the state "⚠"
    When I press "Import"
    Then the import says "Imported 1 workout."
    And the library "ridrs" holds 6 workouts

  Scenario: A pasted intervals.icu text is a workout
    Given the host has started
    And the ridrs UI is shown
    When I press "Open the workout import"
    And I paste the intervals.icu text of "sweet-spot.txt" as "Pasted sweet spot"
    Then the preview lists these workouts:
      | file                  | name              | duration  | state |
      | Pasted sweet spot.txt | Pasted sweet spot | 1 h 9 min | ✓     |
    When I press "Import"
    Then the import says "Imported 1 workout."
    And the library "ridrs" holds the workout "Pasted sweet spot" with the id "pasted-sweet-spot"

  Scenario: The screen speaks German
    Given the rider speaks German
    And the host has started
    And the ridrs UI is shown
    When I press "Open the workout import"
    And I choose the file "run-only.tcx"
    Then the screen says "Workouts importieren"
    And the preview of "run-only.tcx" notes "Das ist kein Radworkout. ridrs importiert nur Radworkouts."
    When I choose the file "watts-3x10.fit"
    Then the preview of "watts-3x10.fit" notes "Vorgaben in Watt, gefahren in Watt."
    When I press "Importieren"
    Then the import says "1 Workout importiert."
