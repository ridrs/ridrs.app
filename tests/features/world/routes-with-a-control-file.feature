Feature: Routes on the device are folders with a control file
  A video route on the device is a folder whose files are an Incyclist package (ADR 0094): a
  `gpx-import` control file, the video and the GPX track it names, and its picture where it has
  one. A source finds its routes by their control files and names every file of a route in its
  offer, so the video world reads the control file and plays the video it names. A downloaded
  package is kept as `route.ride` where its video is stored, not compressed, and unpacked into
  the route's folder otherwise; nothing is renamed and the download goes.

  A route stored before, in the unified format (`route.json`), moves at start: its source writes
  the control file `route.xml` from `route.json` and removes `route.json`. Video, track and
  picture stay as they are; no bytes of the video move.

  Here the media folder is real; the routes in the unified format are written into it before the
  start, as an older ridrs left them.

  Background:
    Given the ridrs plugins "video-source-vangestel, video-source-local, data-archive-node, storage-media-node" together with the simulated downloads

  Scenario: A downloaded route in the unified format gets a control file at start
    Given the media storage holds the Van Gestel route "col-de-pennes" in the unified format
    When the host has started
    Then the route offer "video-source-vangestel/col-de-pennes" is "ready"
    And the route folder "video-source-vangestel/col-de-pennes" holds "route.xml, track.gpx, video.mp4"
    And the route offer "video-source-vangestel/col-de-pennes" names the files "route.xml, track.gpx, video.mp4"
    And the control file of "video-source-vangestel/col-de-pennes" names the video "video.mp4" at 30 frames per second from frame 12

  Scenario: An imported route in the unified format keeps its picture through its control file
    Given the media storage holds the own route "col-de-test" titled "Col de Test" with a picture in the unified format
    When the host has started
    Then the route offer "video-source-local/col-de-test" is "ready"
    And the route folder "video-source-local/col-de-test" holds "route.xml, thumbnail.jpg, track.gpx, video.mp4"
    And the route offer "video-source-local/col-de-test" names the files "route.xml, thumbnail.jpg, track.gpx, video.mp4"
    And the route offer "video-source-local/col-de-test" shows the picture "thumbnail.jpg"
    And the control file of "video-source-local/col-de-test" is titled "Col de Test"

  Scenario: A route moved before is not moved again
    Given the media storage holds the Van Gestel route "col-de-pennes" in the unified format
    And the host has started
    And the route offer "video-source-vangestel/col-de-pennes" is "ready"
    When ridrs restarted
    Then the route offer "video-source-vangestel/col-de-pennes" is "ready"
    And the route folder "video-source-vangestel/col-de-pennes" holds "route.xml, track.gpx, video.mp4"

  Scenario: A downloaded package with a compressed video is unpacked into its route's folder
    Given the host has started
    When the UI bridge calls "route.fetch" with '{"key":"video-source-vangestel/col-de-pennes"}'
    Then the route offer "video-source-vangestel/col-de-pennes" is "ready"
    And the route folder "video-source-vangestel/col-de-pennes" holds "FR_Test.gpx, FR_Test.mp4, FR_Test.xml"
    And the route offer "video-source-vangestel/col-de-pennes" names the files "FR_Test.gpx, FR_Test.mp4, FR_Test.xml"
    And the media storage holds no downloaded package

  Scenario: A downloaded package with a stored video is kept as it is and played from the ZIP
    Given the simulated downloads serve packages with a stored video
    And the host has started
    When the UI bridge calls "route.fetch" with '{"key":"video-source-vangestel/col-de-pennes"}'
    Then the route offer "video-source-vangestel/col-de-pennes" is "ready"
    And the route folder "video-source-vangestel/col-de-pennes" holds "route.ride"
    And the route offer "video-source-vangestel/col-de-pennes" names the files "FR_Test.gpx, FR_Test.mp4, FR_Test.xml"
    And the media storage holds no downloaded package
