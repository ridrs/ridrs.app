@ui
Feature: Files dragged onto the window go to the library
  A rider drags workout files and own video routes onto the app window (ADR 0093). While they
  hover, a layer over the main screen shows a tile for each, like the tile the library will show,
  and says what letting go does; a file ridrs cannot import is ignored, with no layer and no tile. Letting go adds them at once:
  workouts to the own workouts of the ridrs library (a workout the library has already is left
  out), video routes through the import of the local video source. During a ride the main screen
  is not there, and nothing is shown or imported.

  Here the drag is simulated (`data.drop`); recognising, previewing, saving and importing are the
  real plugins on app files and a media folder of the scenario.

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-workout-chart, ui-route-profile, library-ridrs, profile-local, video-source-local, video-import-incyclist, data-archive-node, storage-media-node, file-drop, ui-file-drop" together with the simulated drop
    And the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown

  Scenario: A workout over the window shows its tile and what letting go does
    When the rider drags the workout file "threshold-2x10.erg" onto the window
    Then the drop layer shows the tile "Threshold 2x10"
    And the drop layer says "Let go to add 1 workout to your workouts"
    And the pointer shows that letting go adds them

  Scenario: Letting go of a workout adds it to the own workouts
    Given the rider drags the workout file "threshold-2x10.erg" onto the window
    When the rider lets go of it
    Then the drop layer says "Added 1 workout to your workouts"
    And the library "ridrs" holds 17 workouts
    And the library "ridrs" holds the workout "Threshold 2x10" with the id "threshold-2x10"

  Scenario: A ZIP of workouts shows a tile for each and adds them all
    Given the rider drags the workout file "three-workouts.zip" onto the window
    Then the drop layer shows 3 tiles
    When the rider lets go of it
    Then the library "ridrs" holds 19 workouts

  Scenario: A workout the library has already is not added twice
    Given the rider drags the workout file "threshold-2x10.erg" onto the window
    And the rider lets go of it
    And the library "ridrs" holds 17 workouts
    When the rider drags the workout file "threshold-2x10.erg" onto the window
    Then the drop layer marks "Threshold 2x10" as "Already in your workouts"
    And the pointer shows that letting go adds nothing
    When the rider lets go of it
    Then the drop layer is not shown
    And the library "ridrs" holds 17 workouts

  Scenario: A video route shows its route tile from the package's track
    When the rider drags the Incyclist package "Col_de_Test.ride" onto the window
    Then the drop layer shows the tile "Col de Test"
    And the tile "Col de Test" reads "0.3 km"
    And the drop layer says "Let go to add 1 video route to your routes"

  Scenario: Letting go of a video route imports it
    Given the rider drags the Incyclist package "Col_de_Test.ride" onto the window
    When the rider lets go of it
    Then the route offer "video-source-local/col-de-test" is "ready"
    And the media storage holds the route "video-source-local/col-de-test" titled "Col de Test"

  Scenario: A file ridrs cannot import is ignored
    Given the rider drags the file "Holiday.jpg" onto the window
    When the dragged files are read
    Then the drop layer is not shown
    When the rider lets go of it
    Then the drop layer is not shown
    And the library "ridrs" holds 16 workouts

  Scenario: Dragging the file out of the window again takes the layer away
    Given the rider drags the workout file "threshold-2x10.erg" onto the window
    And the drop layer shows the tile "Threshold 2x10"
    When the rider drags it out of the window again
    Then the drop layer is not shown
    And the library "ridrs" holds 16 workouts
