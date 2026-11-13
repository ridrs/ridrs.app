Feature: A video route dragged onto the window is previewed and imported
  A rider drags an own video route onto the app window: an Incyclist package as `.zip`, or as
  `.ride`, the name ridrs gives these packages (ADR 0093). While it hovers, the local video source
  previews it from the package's GPX track, without copying it: `route.import-preview` answers
  with the route's title, distance, climb and profile, or with why it cannot import the package.
  The title is the one the control file names (`<title>`); without one, its `<name>` without the
  country and with `_` as spaces, as Incyclist names a route; without both, the file's name (ADR
  0094). The picture is the one the control file names (`<preview>`), else the one Incyclist shows
  next to the video (`preview.png`, `preview.jpg`, `<video>_preview.png`, `<video>_preview.jpg`);
  without one, the route has none.
  Letting go imports it through `route.import` with the dropped file instead of the open dialog;
  progress and failure are the source's key of `route.import`, as for a chosen file (ADR 0090).
  The route's folder holds the package as `route.ride` where its video is stored, not compressed,
  else the files it holds, unpacked from the dropped file; nothing is renamed (ADR 0094).

  Here the drag is simulated (`data.drop`); its copying and unpacking can wait. The source and the
  media storage are the real plugins on a media folder of the scenario.

  Background:
    Given the ridrs plugins "video-source-local, storage-media-node" together with the simulated drop
    And pictures are made smaller by the simulated picture provider
    And the host has started

  Scenario: A dragged .ride package is previewed from its track
    Given the rider drags the Incyclist package "Col_de_Test.ride" onto the window
    When the UI bridge calls "route.import-preview" with '{"key":"video-source-local","file":"drop-1"}'
    Then the call resolved with the preview "Col de Test: video, 0.3 km, 12 m"
    And the media storage holds no downloaded package

  Scenario: A package of video2gpx with its own files besides is still a video route
    Given the rider drags the video2gpx package "IT_Driving_the_Amalfi_Coast.zip" onto the window
    When the UI bridge calls "route.import-preview" with '{"key":"video-source-local","file":"drop-1"}'
    Then the call resolved with the preview "Driving the Amalfi Coast: video, 0.3 km, 12 m"

  Scenario: Letting go of a package that names its title imports it under that title
    Given the rider drags the video2gpx package "IT_Driving_the_Amalfi_Coast.zip" onto the window
    When the rider lets go of it
    And the UI bridge calls "route.import" with '{"key":"video-source-local","file":"drop-1"}'
    Then the call resolved with '{"started":true}'
    And the route offer "video-source-local/it-driving-the-amalfi-coast" is "importing"
    And the route offer "video-source-local/it-driving-the-amalfi-coast" is titled "Driving the Amalfi Coast"
    And the route offer "video-source-local/it-driving-the-amalfi-coast" is "ready"
    And the media storage holds the route "video-source-local/it-driving-the-amalfi-coast" titled "Driving the Amalfi Coast"

  Scenario: A package without a title is named as its control file names it, not as its file
    Given the rider drags the Incyclist package "Download (3).ride" onto the window
    When the UI bridge calls "route.import-preview" with '{"key":"video-source-local","file":"drop-1"}'
    Then the call resolved with the preview "Col de Test: video, 0.3 km, 12 m"
    When the rider lets go of it
    And the UI bridge calls "route.import" with '{"key":"video-source-local","file":"drop-1"}'
    Then the route offer "video-source-local/download-3" is "ready"
    And the route offer "video-source-local/download-3" is titled "Col de Test"
    And the media storage holds the route "video-source-local/download-3" titled "Col de Test"

  Scenario: A package's preview picture is the route's picture, before and after the import
    Given the rider drags the Incyclist package "Col_de_Test.ride" with a preview picture onto the window
    When the UI bridge calls "route.import-preview" with '{"key":"video-source-local","file":"drop-1"}'
    Then the call resolved with the preview "Col de Test: video, 0.3 km, 12 m"
    And the preview shows the package's picture
    When the rider lets go of it
    And the UI bridge calls "route.import" with '{"key":"video-source-local","file":"drop-1"}'
    Then the route offer "video-source-local/col-de-test" is "ready"
    And the route offer "video-source-local/col-de-test" shows the picture "preview.jpg"
    And the route offer "video-source-local/col-de-test" shows the tile picture "video-source-local/col-de-test/.tile.jpg"
    And the small picture of "video-source-local/col-de-test" is made from its "preview.jpg"

  Scenario: A ZIP without a control file is no route
    Given the rider drags a ZIP "Holiday.zip" without a control file onto the window
    When the UI bridge calls "route.import-preview" with '{"key":"video-source-local","file":"drop-1"}'
    Then the call resolved with '{"ok":false,"reason":"The package has no control file"}'

  Scenario: Letting go imports the package without the open dialog
    Given the rider drags the Incyclist package "Col_de_Test.ride" onto the window
    And storing the dropped file waits
    When the rider lets go of it
    And the UI bridge calls "route.import" with '{"key":"video-source-local","file":"drop-1"}'
    Then the call resolved with '{"started":true}'
    And the route offer "video-source-local/col-de-test" is "importing"
    And the route offer "video-source-local/col-de-test" reads "0.3 km"
    When storing the dropped file goes on
    Then the route offer "video-source-local/col-de-test" is "ready"
    And the media storage holds the route "video-source-local/col-de-test" titled "Col de Test"
    And the route folder "video-source-local/col-de-test" holds "FR_Test.gpx, FR_Test.mp4, FR_Test.xml"
    And the media storage holds no downloaded package

  Scenario: A dropped package with a stored video is kept as it is
    Given the rider drags the Incyclist package "Col_de_Test.ride" with a stored video onto the window
    When the rider lets go of it
    And the UI bridge calls "route.import" with '{"key":"video-source-local","file":"drop-1"}'
    Then the route offer "video-source-local/col-de-test" is "ready"
    And the route folder "video-source-local/col-de-test" holds "route.ride"
    And the route offer "video-source-local/col-de-test" names the files "FR_Test.gpx, FR_Test.mp4, FR_Test.xml"
    And the media storage holds the route "video-source-local/col-de-test" titled "Col de Test"

  Scenario: A file dragged out of the window again cannot be imported
    Given the rider drags the Incyclist package "Col_de_Test.ride" onto the window
    When the rider drags it out of the window again
    And the UI bridge calls "route.import" with '{"key":"video-source-local","file":"drop-1"}'
    Then the call was rejected with "service-failed" and the message "The dragged file \"drop-1\" is gone"
    And the media storage holds no route "video-source-local/col-de-test"

  Scenario: A moved package is removed from where it lay once its route is imported
    Given the rider drags the Incyclist package "Col_de_Test.ride" onto the window
    And storing the dropped file waits
    When the rider lets go of it
    And the UI bridge calls "route.import" with '{"key":"video-source-local","file":"drop-1","move":true}'
    Then the route offer "video-source-local/col-de-test" is "importing"
    And the dragged file "Col_de_Test.ride" is still where it lay
    When storing the dropped file goes on
    Then the route offer "video-source-local/col-de-test" is "ready"
    And the dragged file "Col_de_Test.ride" is removed from where it lay

  Scenario: A moved package whose import fails stays where it lay
    Given the rider drags a ZIP "Holiday.zip" without a control file onto the window
    When the rider lets go of it
    And the UI bridge calls "route.import" with '{"key":"video-source-local","file":"drop-1","move":true}'
    Then the route import "video-source-local" failed
    And the dragged file "Holiday.zip" is still where it lay
