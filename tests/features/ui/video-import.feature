@ui
Feature: Importing an own video route from an Incyclist package
  A rider brings own routes into ridrs as Incyclist packages: a ZIP with the video, its GPX track
  and the control file. On the ride page the first card of real video imports one: the system's
  open dialog chooses the ZIP (`data.pick`), the local video source copies it into the media
  storage, `data.archive` unpacks it and the importer of the Incyclist format turns it into a
  ridrs video route (`route.json`, `video.mp4`, `track.gpx`). The route is then an offer of the
  local source in the app state `route.offer`, on this device and removable, with its distance,
  its climb and its profile from the track. Import is a call of the service `route.import`; while
  the package is imported, and when it failed, the card says so through the source's key of the
  app state `route.import` (ADR 0068).

  Here the open dialog is simulated: it chooses a small Incyclist package with its control file in
  UTF-16, or the rider cancels it. Unpacking, import and media storage are the real plugins on a
  media folder of the scenario.

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-activity-screen, ui-landscape-demo, ui-area-ride, ui-route-profile, video-source-local, video-import-incyclist, data-archive-node, storage-media-node" together with the simulated open dialog
    And the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown

  Scenario: The import is the first card of real video
    When I press "Ride"
    Then the section "Real video" lists "Import video" first
    And the section "Real video" lists 1 routes

  Scenario: An imported package can be ridden
    Given the rider chooses the Incyclist package "Col de Test.zip"
    When I press "Ride"
    And I press "Import video"
    Then the section "Real video" lists "Col de Test"
    And the section "Real video" lists "Import video" first
    And the route "Col de Test" reads "0.3 km"
    And the route "Col de Test" reads "12 m"
    And the route "Col de Test" shows the status "On this device"
    And the media storage holds the route "video-source-local/col-de-test" titled "Col de Test"
    And the media storage holds no downloaded package
    When I press "Col de Test"
    Then the route details offer a "Go" button
    When I press "Go"
    Then the "activity" screen is shown
    And the ride was requested in the world "ui-world-video/landscape" on the route "video-source-local/col-de-test"

  Scenario: A .ride file is an Incyclist package
    Given the rider chooses the Incyclist package "Col_de_Test.ride"
    When I press "Ride"
    And I press "Import video"
    Then the open dialog offered Incyclist packages as "zip, ride"
    And the section "Real video" lists "Col de Test"
    And the media storage holds the route "video-source-local/col-de-test" titled "Col de Test"
    And the media storage holds no downloaded package

  Scenario: An imported route stays on the device
    Given the rider chooses the Incyclist package "Col de Test.zip"
    When I press "Ride"
    And I press "Import video"
    Then the section "Real video" lists "Col de Test"
    When ridrs restarted
    And I reload the UI
    And I press "Ride"
    Then the section "Real video" lists "Col de Test"
    And the route "Col de Test" reads "0.3 km"

  Scenario: The same package imported twice is two routes
    Given the rider chooses the Incyclist package "Col de Test.zip"
    When I press "Ride"
    And I press "Import video"
    Then the section "Real video" lists "Col de Test"
    When I press "Import video"
    Then the section "Real video" lists 3 routes
    And the media storage holds the route "video-source-local/col-de-test-2" titled "Col de Test"

  Scenario: A cancelled choice imports nothing
    Given the rider cancels the open dialog
    When I press "Ride"
    And I press "Import video"
    Then the section "Real video" lists 1 routes
    And the route "Import video" does not read "failed"

  Scenario: A package that is not an Incyclist package says why
    Given the rider chooses a ZIP "Holiday.zip" without a control file
    When I press "Ride"
    And I press "Import video"
    Then the route "Import video" reads "Import failed: The package has no control file"
    And the section "Real video" lists 1 routes
    And the media storage holds no route "video-source-local/holiday"
    And the media storage holds no downloaded package

  Scenario: An imported route can be removed from the device
    Given the rider chooses the Incyclist package "Col de Test.zip"
    When I press "Ride"
    And I press "Import video"
    And I press "Col de Test"
    And I press "Remove from this device"
    Then the section "Real video" does not list "Col de Test"
    And the media storage holds no route "video-source-local/col-de-test"
