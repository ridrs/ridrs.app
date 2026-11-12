Feature: A video route dragged onto the window is previewed and imported
  A rider drags an own video route onto the app window: an Incyclist package as `.zip`, or as
  `.ride`, the name ridrs gives these packages (ADR 0093). While it hovers, the local video source
  previews it from the package's GPX track, without copying it: `route.import-preview` answers
  with the route's title, distance, climb and profile, or with why it cannot import the package.
  The title is the one the control file names (`<title>`); without one, the file's name. The
  picture is the one Incyclist shows next to the video (`preview.png`, `preview.jpg`,
  `<video>_preview.png`, `<video>_preview.jpg`), else ridrs' own `thumbnail.png` or `thumbnail.jpg`;
  without one, the route has none.
  Letting go imports it through `route.import` with the dropped file instead of the open dialog;
  progress and failure are the source's key of `route.import`, as for a chosen file (ADR 0090).

  Here the drag is simulated (`data.drop`); the import, unpacking and media storage are the real
  plugins on a media folder of the scenario.

  Background:
    Given the ridrs plugins "video-source-local, video-import-incyclist, data-archive-node, storage-media-node" together with the simulated drop
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

  Scenario: A package's preview picture is the route's picture, before and after the import
    Given the rider drags the Incyclist package "Col_de_Test.ride" with a preview picture onto the window
    When the UI bridge calls "route.import-preview" with '{"key":"video-source-local","file":"drop-1"}'
    Then the call resolved with the preview "Col de Test: video, 0.3 km, 12 m"
    And the preview shows the package's picture
    When the rider lets go of it
    And the UI bridge calls "route.import" with '{"key":"video-source-local","file":"drop-1"}'
    Then the route offer "video-source-local/col-de-test" is "ready"
    And the route offer "video-source-local/col-de-test" shows the picture "thumbnail.jpg"

  Scenario: A ZIP without a control file is no route
    Given the rider drags a ZIP "Holiday.zip" without a control file onto the window
    When the UI bridge calls "route.import-preview" with '{"key":"video-source-local","file":"drop-1"}'
    Then the call resolved with '{"ok":false,"reason":"The package has no control file"}'

  Scenario: Letting go imports the package without the open dialog
    Given the rider drags the Incyclist package "Col_de_Test.ride" onto the window
    And copying the dropped file waits
    When the rider lets go of it
    And the UI bridge calls "route.import" with '{"key":"video-source-local","file":"drop-1"}'
    Then the call resolved with '{"started":true}'
    And the route offer "video-source-local/col-de-test" is "importing"
    And the route offer "video-source-local/col-de-test" reads "0.3 km"
    When copying the dropped file goes on
    Then the route offer "video-source-local/col-de-test" is "ready"
    And the media storage holds the route "video-source-local/col-de-test" titled "Col de Test"
    And the media storage holds no downloaded package

  Scenario: A file dragged out of the window again cannot be imported
    Given the rider drags the Incyclist package "Col_de_Test.ride" onto the window
    When the rider drags it out of the window again
    And the UI bridge calls "route.import" with '{"key":"video-source-local","file":"drop-1"}'
    Then the call was rejected with "service-failed" and the message "The dragged file \"drop-1\" is gone"
    And the media storage holds no route "video-source-local/col-de-test"
