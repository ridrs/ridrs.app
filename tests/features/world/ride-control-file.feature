Feature: The control file of a ride package
  A `.ride` package is an Incyclist video package (ADR 0094): its `gpx-import` control file names
  the video, the GPX track and the route's timing, notes and segments. ridrs reads it as Incyclist
  does, its name, its title per language and the picture it names included, and writes one for a
  route stored in the old unified format (`route.json`) so that the route needs no other change.
  The package `@ridrs/ride` does both, without a GUI.

  Scenario: The title is the control file's title
    Given the control file
      """
      <gpx-import>
        <name>FR_Col_de_Pennes</name>
        <title>Col de Pennes - Climb it twice!</title>
        <video-file-path>FR_Col_de_Pennes.mp4</video-file-path>
        <gpx-file-path>FR_Col_de_Pennes.gpx</gpx-file-path>
      </gpx-import>
      """
    When the control file is read
    Then the route's title is "Col de Pennes - Climb it twice!"

  Scenario: The name is read without its country
    Given the control file
      """
      <gpx-import>
        <name>FR_Col_de_Pennes</name>
        <video-file-path>FR_Col_de_Pennes.mp4</video-file-path>
        <gpx-file-path>FR_Col_de_Pennes.gpx</gpx-file-path>
      </gpx-import>
      """
    When the control file is read
    Then the route has no title
    And the route's name is "Col de Pennes"

  Scenario: A title per language is read in its first language
    Given the control file
      """
      <gpx-import>
        <title><de>Amalfiküste</de><en>Amalfi Coast</en></title>
        <video-file-path>IT_Amalfi.mp4</video-file-path>
        <gpx-file-path>IT_Amalfi.gpx</gpx-file-path>
      </gpx-import>
      """
    When the control file is read
    Then the route's title is "Amalfiküste"

  Scenario: Elements Incyclist does not know are ignored
    Given the control file
      """
      <gpx-import>
        <title>Col de Test</title>
        <credits author="Someone" license="CC BY 4.0"/>
        <smooth repeat="3">10</smooth>
        <video-file-path>Col.mp4</video-file-path>
        <gpx-file-path>Col.gpx</gpx-file-path>
        <framerate>50</framerate>
      </gpx-import>
      """
    When the control file is read
    Then the route's title is "Col de Test"
    And the route's frame rate is 50

  Scenario: The picture is the one the control file names
    Given the control file
      """
      <gpx-import>
        <video-file-path>Col.mp4</video-file-path>
        <gpx-file-path>Col.gpx</gpx-file-path>
        <preview>pictures/col.jpg</preview>
      </gpx-import>
      """
    When the control file is read
    Then among the files "preview.png, pictures/col.jpg, Col.mp4" the route's picture is "pictures/col.jpg"

  Scenario: Without one, the picture is one Incyclist looks for next to the video
    Given the control file
      """
      <gpx-import>
        <video-file-path>Col.mp4</video-file-path>
        <gpx-file-path>Col.gpx</gpx-file-path>
      </gpx-import>
      """
    When the control file is read
    Then among the files "Col.mp4, thumbnail.jpg, Col_preview.JPG" the route's picture is "Col_preview.JPG"
    And among the files "Col.mp4, thumbnail.jpg, thumbnail.png" the route has no picture

  Scenario: A route in the unified format gets a control file that reads back the same
    Given the route in the unified format
      """
      {
        "format": "ridrs-video-route",
        "version": 1,
        "title": "Col de Pennes & Jansac",
        "notes": [{ "distance": 20, "text": { "de": "Col de Pennes\nLänge: 46,2 km", "en": "Col de Pennes\nLength: 46.2 km" } }],
        "segments": [{ "name": "First climb <11.2 km>", "start": 0, "end": 11230 }],
        "video": { "file": "video.mp4", "framerate": 29.97, "startFrame": 12 },
        "track": { "file": "track.gpx" },
        "thumbnail": { "file": "thumbnail.jpg" },
        "imported": { "by": "video-import-incyclist", "version": "1" }
      }
      """
    When a control file is written for it
    And the control file is read
    Then the route's title is "Col de Pennes & Jansac"
    And the route's video is "video.mp4" at 29.97 frames per second from frame 12
    And the route's track is "track.gpx"
    And the route's picture is named "thumbnail.jpg"
    And the route's note at 20 m reads "Col de Pennes\nLänge: 46,2 km" in "de"
    And the route's segment "First climb <11.2 km>" runs from 0 m to 11230 m
