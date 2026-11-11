@training
Feature: The ridrs library keeps the rider's own and imported workouts
  The plugin library-ridrs is the writable library "ridrs" (structured-workouts.md, sections 4.1
  and 8): `training.library.save` adds a workout or replaces the one with its id, `.remove` takes
  one out. Each workout is an app file of its own; the bytes of an imported file are an app file
  named by their SHA-256, which `workout.source.originalHash` names (layer 3). The built-in
  workouts stay read only: a save or a removal under their id is refused.

  Background:
    Given the ridrs plugins "library-ridrs" running with app files

  Scenario: A saved workout is in the library beside the built-in ones, with its original
    When the rider saves the file "sweet-spot-3x12.zwo" to the ridrs library as "club-sweet-spot"
    Then the save succeeded
    And the library "ridrs" is writable
    And the library "ridrs" holds 6 workouts
    And the library "ridrs" holds the workout "Sweet Spot 3x12" with the id "club-sweet-spot"
    And the original of "club-sweet-spot" is kept as an app file named by its SHA-256

  Scenario: What was saved is there after a restart
    Given the rider has saved the file "sweet-spot-3x12.zwo" to the ridrs library as "club-sweet-spot"
    When the host restarts
    Then the library "ridrs" holds the workout "Sweet Spot 3x12" with the id "club-sweet-spot"
    And the original of "club-sweet-spot" is kept as an app file named by its SHA-256

  Scenario: Saving under an id again replaces the workout
    Given the rider has saved the file "sweet-spot-3x12.zwo" to the ridrs library as "mine"
    When the rider saves the file "threshold-2x10.erg" to the ridrs library as "mine"
    Then the library "ridrs" holds 6 workouts
    And the library "ridrs" holds the workout "Threshold 2x10" with the id "mine"
    And no original is kept for the file "sweet-spot-3x12.zwo"

  Scenario: A built-in workout cannot be overwritten
    When the rider saves the file "sweet-spot-3x12.zwo" to the ridrs library as "sweet-spot-3x12"
    Then the save was refused as "read-only"
    And the library "ridrs" holds 5 workouts
    And the library "ridrs" holds the workout "Sweet Spot 3×12" with the id "sweet-spot-3x12"

  Scenario: A built-in workout cannot be removed
    When the rider removes the workout "sweet-spot-3x12" from the ridrs library
    Then the removal was refused as "read-only"
    And the library "ridrs" holds 5 workouts

  Scenario: Removing an own workout takes its file and its original with it
    Given the rider has saved the file "over-unders.mrc" to the ridrs library as "my-unders"
    When the rider removes the workout "my-unders" from the ridrs library
    Then the library "ridrs" holds 5 workouts
    And no original is kept for the file "over-unders.mrc"
    When the host restarts
    Then the library "ridrs" holds 5 workouts

  Scenario: Copies of one import share the original until the last one is removed
    Given the rider has saved the file "over-unders.mrc" to the ridrs library as "unders"
    And the rider has saved the file "over-unders.mrc" to the ridrs library as "unders-copy"
    When the rider removes the workout "unders" from the ridrs library
    Then the original of "unders-copy" is kept as an app file named by its SHA-256
    When the rider removes the workout "unders-copy" from the ridrs library
    Then no original is kept for the file "over-unders.mrc"

  Scenario: An original that does not match its hash is refused
    When the rider saves the file "over-unders.mrc" to the ridrs library with the original of "threshold-2x10.erg"
    Then the save failed with "invalid-request"
    And the library "ridrs" holds 5 workouts
