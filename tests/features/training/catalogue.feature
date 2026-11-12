@training
Feature: The built-in workout catalogue
  The plugin library-ridrs is the provider "ridrs" of the workout library (ADR 0075, ADR 0086):
  sixteen workouts, one or more of each kind from recovery to openers, loaded from canonical
  files, read only. Each has an author and the
  licence CC-BY-SA-4.0, its steps, and a length and load derived from them.

  Background:
    Given the ridrs plugins "library-ridrs" running

  Scenario: The built-in workouts are in the library of ridrs, from easy to hard
    Then the library "ridrs" holds the workouts "Recovery Spin-Ups, Gentle Waves, Long Endurance 2×50, Tractor Diesel, Half Hour Twice, Sweet Spot 3×12, Diesel and Punch, Threshold Foundation 3×15, Hour Power Peak, Lactate Shuttle, VO2max 4×4, Oxygen Thief 7×4, VO2max 30/15, Heartbreaker 40/20, The Aggressor, Race Primer"
    And every catalogue workout has the author "ridrs" and the licence "CC-BY-SA-4.0"
    And the library "ridrs" is read only

  Scenario: Every catalogue workout carries its steps, length and load
    Then every catalogue workout has steps, a duration and a training load
    And the catalogue workout "Sweet Spot 3×12" lasts 3780 seconds

  Scenario: Threshold Foundation 3×15 asks for 85-95 rpm in its efforts
    Then the catalogue workout "Threshold Foundation 3×15" has a cadence target of 85 to 95 rpm in its repeat
