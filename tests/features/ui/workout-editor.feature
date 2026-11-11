@ui @training
Feature: The workout editor
  The basic editor (structured-workouts.md, section 12; a workbench screen, ADR 0080: pointer and
  touch first): a live chart on top (`ui.workout-chart`, variant `edit`), the steps below. New
  workouts, own workouts and built-in workouts "as a copy"; steps of the kinds warm-up, steady,
  ramp, range, cool-down, free ride, max effort and interval block; undo and redo; validation;
  saving through `training.library.save` of the library `ridrs`.

  Here a fixture library stands in for the `ridrs` library: a built-in workout, an own one
  "My Intervals" (warm-up, 3 × 4 min on and 2 min off, cool-down) with three future planned
  days, and an imported one with steps by heart rate and distance. A fixture host lists them.

  Background:
    Given the ridrs plugins "ui-settings, profile-local, ui-workout-chart, ui-workout-details, ui-workout-editor" with the workout editor fixtures
    And the athlete profile on this device holds an FTP of 250 W and a weight of 72 kg

  Scenario: A new workout shows its duration and load while it is built
    Given the host has started
    And the ridrs UI is shown
    When I open the workout editor for a new workout
    And I name the workout "Test ride" in the workout editor
    And I add the step "Warm-up" in the workout editor
    And I add the step "Interval block" in the workout editor
    Then the workout editor shows the numbers:
      | Duration | 28 min |
      | TSS      | 33     |
      | IF       | 0.84   |
    And the workout editor lists the steps:
      | step          | duration | target |
      | Warm-up       | 10:00    | 50–75  |
      | Block of 3×   |          |        |
      | Interval      | 4:00     | 100    |
      | Recovery      | 2:00     | 50     |
    And the workout editor chart draws 7 steps

  Scenario: The power and the duration of an interval are edited
    Given the host has started
    And the ridrs UI is shown
    When I open the details of the workout "My Intervals"
    And I press "Edit" in the details of the workout
    And I set "power-value" of the step "On" to "105" in the workout editor
    And I set "duration" of the step "On" to "5:00" in the workout editor
    Then the workout editor lists the steps:
      | step        | duration | target |
      | Warm up     | 10:00    | 50–75  |
      | Block of 3× |          |        |
      | On          | 5:00     | 105    |
      | Off         | 2:00     | 50     |
      | Cool down   | 5:00     | 65–45  |
    And the workout editor shows the numbers:
      | Duration | 36 min |
      | TSS      | 45     |
      | IF       | 0.87   |

  Scenario: Dragging an edge in the chart snaps to 15 seconds and to 1 percent
    Given the host has started
    And the ridrs UI is shown
    When I open the details of the workout "My Intervals"
    And I press "Edit" in the details of the workout
    And I select the step "a" in the workout editor chart
    And I drag the "duration" handle of the step "a" in the workout editor chart by 10 across and 0 down
    Then the workout editor lists the step "On" with the duration "4:30" and the target "100"
    When I drag the "power" handle of the step "a" in the workout editor chart by 0 across and -20 down
    Then the workout editor lists the step "On" with the duration "4:30" and the target "114"

  Scenario: A drag in the chart is one step to undo
    Given the host has started
    And the ridrs UI is shown
    When I open the details of the workout "My Intervals"
    And I press "Edit" in the details of the workout
    And I select the step "a" in the workout editor chart
    And I drag the "duration" handle of the step "a" in the workout editor chart by 10 across and 0 down
    And I press "Undo" in the workout editor
    Then the workout editor lists the step "On" with the duration "4:00" and the target "100"

  Scenario: Undo and redo take back and bring back an edit, by button and by keyboard
    Given the host has started
    And the ridrs UI is shown
    When I open the details of the workout "My Intervals"
    And I press "Edit" in the details of the workout
    And I set "power-value" of the step "On" to "120" in the workout editor
    And I press "Undo" in the workout editor
    Then the workout editor lists the step "On" with the duration "4:00" and the target "100"
    When I press "Redo" in the workout editor
    Then the workout editor lists the step "On" with the duration "4:00" and the target "120"
    When I press Ctrl+Z in the workout editor
    Then the workout editor lists the step "On" with the duration "4:00" and the target "100"
    When I press Ctrl+Shift+Z in the workout editor
    Then the workout editor lists the step "On" with the duration "4:00" and the target "120"

  Scenario: A power of 350 percent is refused with its reason
    Given the host has started
    And the ridrs UI is shown
    When I open the details of the workout "My Intervals"
    And I press "Edit" in the details of the workout
    And I set "power-value" of the step "On" to "350" in the workout editor
    Then the workout editor shows the error "350 % FTP is above 300 %." at the step "On"
    And the workout editor cannot be saved

  Scenario: A workout needs a name and a step
    Given the host has started
    And the ridrs UI is shown
    When I open the workout editor for a new workout
    Then the workout editor cannot be saved
    And the workout editor shows the problem "The workout needs a name."
    And the workout editor shows the problem "The workout needs at least one step."

  Scenario: A step is wrapped in a repeat and unwrapped again
    Given the host has started
    And the ridrs UI is shown
    When I open the details of the workout "My Intervals"
    And I press "Edit" in the details of the workout
    And I press "Repeat" on the step "Cool down" in the workout editor
    Then the workout editor lists the steps:
      | step        | duration | target |
      | Warm up     | 10:00    | 50–75  |
      | Block of 3× |          |        |
      | On          | 4:00     | 100    |
      | Off         | 2:00     | 50     |
      | Block of 2× |          |        |
      | Cool down   | 5:00     | 65–45  |
    When I set "reps" of the step "Block of 2×" to "4" in the workout editor
    And I press "Unwrap block" on the step "Block of 4×" in the workout editor
    Then the workout editor lists the steps:
      | step        | duration | target |
      | Warm up     | 10:00    | 50–75  |
      | Block of 3× |          |        |
      | On          | 4:00     | 100    |
      | Off         | 2:00     | 50     |
      | Cool down   | 5:00     | 65–45  |

  Scenario: Steps are reordered by drag and drop
    Given the host has started
    And the ridrs UI is shown
    When I open the details of the workout "My Intervals"
    And I press "Edit" in the details of the workout
    And I drag the step "Cool down" before the step "Warm up" in the workout editor
    Then the workout editor lists the steps:
      | step        | duration | target |
      | Cool down   | 5:00     | 65–45  |
      | Warm up     | 10:00    | 50–75  |
      | Block of 3× |          |        |
      | On          | 4:00     | 100    |
      | Off         | 2:00     | 50     |

  Scenario: A step is dragged into a block
    Given the host has started
    And the ridrs UI is shown
    When I open the details of the workout "My Intervals"
    And I press "Edit" in the details of the workout
    And I drag the step "Cool down" to the end of the block in the workout editor
    Then the workout editor lists the steps:
      | step        | duration | target |
      | Warm up     | 10:00    | 50–75  |
      | Block of 3× |          |        |
      | On          | 4:00     | 100    |
      | Off         | 2:00     | 50     |
      | Cool down   | 5:00     | 65–45  |

  Scenario: A step is duplicated and deleted
    Given the host has started
    And the ridrs UI is shown
    When I open the details of the workout "My Intervals"
    And I press "Edit" in the details of the workout
    And I press "Duplicate" on the step "Cool down" in the workout editor
    And I press "Delete" on the step "Warm up" in the workout editor
    Then the workout editor lists the steps:
      | step        | duration | target |
      | Block of 3× |          |        |
      | On          | 4:00     | 100    |
      | Off         | 2:00     | 50     |
      | Cool down   | 5:00     | 65–45  |
      | Cool down   | 5:00     | 65–45  |

  Scenario: A built-in workout is edited as a copy and saved as a new workout of the rider
    Given the host has started
    And the ridrs UI is shown
    When I open the details of the workout "Sweet Spot 3x12"
    Then the details of the workout offer "Edit as a copy" and not "Edit"
    When I press "Edit as a copy" in the details of the workout
    Then the workout editor shows the name "Copy of Sweet Spot 3x12"
    And the workout editor shows no notice about planned days
    When I save the workout in the workout editor
    Then the details of the workout show the name "Copy of Sweet Spot 3x12"
    And the library holds the workouts "sweet-spot-3x12, my-intervals, heart-rate-endurance, copy-of-sweet-spot-3x12"
    And the library workout "copy-of-sweet-spot-3x12" is the rider's own, by "ridrs" under "CC-BY-SA-4.0"

  Scenario: An own workout keeps its id when it is saved
    Given the host has started
    And the ridrs UI is shown
    When I open the details of the workout "My Intervals"
    Then the details of the workout offer "Edit" and not "Edit as a copy"
    When I press "Edit" in the details of the workout
    And I name the workout "My Better Intervals" in the workout editor
    And I save the workout in the workout editor
    Then the details of the workout show the name "My Better Intervals"
    And the library holds the workouts "sweet-spot-3x12, my-intervals, heart-rate-endurance"
    And the library workout "my-intervals" is named "My Better Intervals"

  Scenario: The editor says how many days are planned with the workout
    Given the host has started
    And the ridrs UI is shown
    When I open the details of the workout "My Intervals"
    And I press "Edit" in the details of the workout
    Then the workout editor shows the notice "Planned on 3 days; they change with it."
    When I set "power-value" of the step "On" to "110" in the workout editor
    And I save the workout in the workout editor
    Then the details of the workout show the name "My Intervals"

  Scenario: Heart rate and distance steps of an imported workout are shown and can be deleted
    Given the host has started
    And the ridrs UI is shown
    When I open the details of the workout "Heart Rate Endurance"
    And I press "Edit" in the details of the workout
    Then the workout editor lists the step "Steady heart rate" as kept as imported with "130–140 bpm"
    And the workout editor lists the step "Five kilometres" as kept as imported with "5 km"
    When I press "Delete" on the step "Steady heart rate" in the workout editor
    Then the workout editor lists the steps:
      | step              | duration | target |
      | Easy spin         | 10:00    | 55     |
      | Five kilometres   |          |        |

  Scenario: Closing the editor returns to the details
    Given the host has started
    And the ridrs UI is shown
    When I open the details of the workout "My Intervals"
    And I press "Edit" in the details of the workout
    And I press "Cancel" in the workout editor
    Then the details of the workout show the name "My Intervals"

  Scenario: The editor speaks German
    Given the rider speaks German
    And the host has started
    And the ridrs UI is shown
    When I open the workout editor for a new workout
    Then the workout editor shows the heading "Neues Workout"
    When I add the step "Aufwärmen" in the workout editor
    And I set "power-from" of the step "Aufwärmen" to "350" in the workout editor
    Then the workout editor shows the error "350 % FTP liegt über 300 %." at the step "Aufwärmen"
    And the workout editor has the buttons "Rückgängig, Wiederholen, Speichern, Abbrechen"
