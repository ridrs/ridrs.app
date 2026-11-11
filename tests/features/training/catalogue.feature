@training
Feature: The built-in workout catalogue
  The plugin library-ridrs is the provider "ridrs" of the workout library (ADR 0075, ADR 0086):
  five example workouts, loaded from canonical files, read only. Each has an author and the
  licence CC-BY-SA-4.0, its steps, and a length and load derived from them.

  Background:
    Given the ridrs plugins "library-ridrs" running

  Scenario: The five built-in workouts are in the library of ridrs
    Then the library "ridrs" holds the workouts "Sweet Spot 3×12, VO2max 5×4, Over-Unders 3×(4×3′), Endurance 75 with drills, Microbursts 30/30"
    And every catalogue workout has the author "ridrs" and the licence "CC-BY-SA-4.0"
    And the library "ridrs" is read only

  Scenario: Every catalogue workout carries its steps, length and load
    Then every catalogue workout has steps, a duration and a training load
    And the catalogue workout "Sweet Spot 3×12" lasts 3780 seconds

  Scenario: VO2max 5×4 asks for 95-105 rpm in its efforts
    Then the catalogue workout "VO2max 5×4" has a cadence target of 95 to 105 rpm in its repeat
