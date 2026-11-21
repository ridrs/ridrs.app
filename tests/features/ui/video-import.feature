@ui
Feature: Importing an own video route from an Incyclist package
  A rider brings own routes into ridrs as Incyclist packages: a ZIP with the video, its GPX track
  and the control file. On the ride page the first card of the section Scenic imports one: the system's
  open dialog chooses the ZIP (`data.pick`), and the local video source stores it as a route's
  folder (ADR 0094): a package whose video is stored, not compressed, is copied as `route.ride` and
  played from the ZIP; any other is unpacked into the folder from the chosen file. Nothing is
  renamed and nothing is written beside it. The route is then an offer of the local source in the
  app state `route.offer`, on this device and removable, with its distance, its climb and its
  profile from the track. Import is a call of the service `route.import`. While the package is
  stored, its route is listed at once and says how far it is, as a download does. The import card
  then says nothing of it; when an import failed, the card says why through the source's key of
  the app state `route.import` (ADR 0068).

  Here the open dialog is simulated: it chooses a small Incyclist package with its control file in
  UTF-16, its video compressed or stored, or the rider cancels it. Copying and unpacking can wait,
  before they start or halfway. The source and the media storage are the real plugins on a media
  folder of the scenario.

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-activity-screen, ui-landscape-demo, ui-area-ride, ui-route-profile, video-source-local, storage-media-node" together with the simulated open dialog
    And the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown

  Scenario: The import is the first card of the section Scenic
    When I press "Ride"
    Then the section "Scenic" lists "Import video" first
    And the section "Scenic" lists 1 routes

  Scenario: An imported package can be ridden
    Given the rider chooses the Incyclist package "Col de Test.zip"
    When I press "Ride"
    And I press "Import video"
    Then the section "Scenic" lists "Col de Test"
    And the section "Scenic" lists "Import video" first
    And the route "Col de Test" reads "0.3 km"
    And the route "Col de Test" reads "12 m"
    And the route "Col de Test" shows the status "On this device"
    And the media storage holds the route "video-source-local/col-de-test" titled "Col de Test"
    And the route folder "video-source-local/col-de-test" holds "FR_Test.gpx, FR_Test.mp4, FR_Test.xml"
    And the media storage holds no downloaded package
    When I press "Col de Test"
    Then the route details offer a "Go" button
    When I press "Go"
    Then the "activity" screen is shown
    And the ride was requested in the world "ui-world-video/landscape" on the route "video-source-local/col-de-test"

  Scenario: A package being imported is listed at once, and can be ridden once it is imported
    Given the rider chooses the Incyclist package "Col de Test.zip"
    And storing the chosen package waits
    When I press "Ride"
    And I press "Import video"
    Then the section "Scenic" lists "Col de Test"
    And the route "Col de Test" shows the status "Importing"
    When I press "Col de Test"
    Then the route details offer no "Go" button
    When storing the chosen package goes on
    Then the route details offer a "Go" button

  Scenario: A package being imported shows how far it is, and the import card stays quiet
    Given the rider chooses the Incyclist package "Col de Test.zip"
    And storing the chosen package waits halfway
    When I press "Ride"
    And I press "Import video"
    Then the route "Col de Test" shows the status "Importing"
    And the route "Col de Test" reads "50 %"
    And the route "Import video" does not read "Col de Test.zip"
    And the route "Import video" does not read "Importing"
    When I press "Col de Test"
    Then the route details read "Importing: 50 %"
    When storing the chosen package goes on
    Then the route details offer a "Go" button

  Scenario: A package with a stored video is kept as it is and played from the ZIP
    Given the rider chooses the Incyclist package "Col de Test.zip" with a stored video
    And storing the chosen package waits halfway
    When I press "Ride"
    And I press "Import video"
    Then the route "Col de Test" reads "50 %"
    When storing the chosen package goes on
    Then the route "Col de Test" shows the status "On this device"
    And the route folder "video-source-local/col-de-test" holds "route.ride"
    And the media storage holds the route "video-source-local/col-de-test" titled "Col de Test"
    When I press "Col de Test"
    Then the route details offer a "Go" button

  Scenario: A package that fails to import is listed no more
    Given the rider chooses a ZIP "Holiday.zip" without a control file
    When I press "Ride"
    And I press "Import video"
    Then the route "Import video" reads "Import failed: The package has no control file"
    And the section "Scenic" does not list "Holiday"

  Scenario: A .ride file is an Incyclist package
    Given the rider chooses the Incyclist package "Col_de_Test.ride"
    When I press "Ride"
    And I press "Import video"
    Then the open dialog offered Incyclist packages as "zip, ride"
    And the section "Scenic" lists "Col de Test"
    And the route "Col de Test" shows the status "On this device"
    And the media storage holds the route "video-source-local/col-de-test" titled "Col de Test"
    And the media storage holds no downloaded package

  Scenario: An imported route stays on the device
    Given the rider chooses the Incyclist package "Col de Test.zip"
    When I press "Ride"
    And I press "Import video"
    Then the section "Scenic" lists "Col de Test"
    And the route "Col de Test" shows the status "On this device"
    When ridrs restarted
    And I reload the UI
    And I press "Ride"
    Then the section "Scenic" lists "Col de Test"
    And the route "Col de Test" reads "0.3 km"

  Scenario: The same package imported twice is two routes
    Given the rider chooses the Incyclist package "Col de Test.zip"
    When I press "Ride"
    And I press "Import video"
    Then the section "Scenic" lists "Col de Test"
    And the route "Col de Test" shows the status "On this device"
    When I press "Import video"
    Then the section "Scenic" lists 3 routes
    And the route offer "video-source-local/col-de-test-2" is "ready"
    And the media storage holds the route "video-source-local/col-de-test-2" titled "Col de Test"

  Scenario: A cancelled choice imports nothing
    Given the rider cancels the open dialog
    When I press "Ride"
    And I press "Import video"
    Then the section "Scenic" lists 1 routes
    And the route "Import video" does not read "failed"

  Scenario: A package that is not an Incyclist package says why
    Given the rider chooses a ZIP "Holiday.zip" without a control file
    When I press "Ride"
    And I press "Import video"
    Then the route "Import video" reads "Import failed: The package has no control file"
    And the section "Scenic" lists 1 routes
    And the media storage holds no route "video-source-local/holiday"
    And the media storage holds no downloaded package

  Scenario: An imported route can be removed from the device
    Given the rider chooses the Incyclist package "Col de Test.zip"
    When I press "Ride"
    And I press "Import video"
    And I press "Col de Test"
    And I press "Remove from this device"
    Then the section "Scenic" does not list "Col de Test"
    And the media storage holds no route "video-source-local/col-de-test"
