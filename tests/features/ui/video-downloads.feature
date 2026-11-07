@ui
Feature: Downloading a video route
  A video source decides that its routes need a download (docs/ideas/video-sources.md). The rider
  downloads one on the ride page: `data.fetch` fetches the source's package into the media
  storage, `data.archive` unpacks it, the importer of the package's format turns it into a ridrs
  video route (`route.json`, `video.mp4`, `track.gpx`), and the route can be ridden. Download and
  Remove are calls of the source's services `route.fetch` and `route.remove`; the progress is the
  offer's key in the app state `route.offer`, changed for that route only (ADR 0068).

  Here the downloads are simulated: they serve a small Incyclist route, with its control file in
  UTF-16 as some of the Van Gestel routes have, in place of every video's ZIP. Unpacking, import
  and media storage are the real plugins on a media folder of the scenario.

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-activity-screen, ui-landscape-demo, ui-area-ride, video-source-vangestel, video-import-incyclist, data-archive-node, storage-media-node" together with the simulated downloads
    And the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown

  Scenario: A downloaded route can be ridden
    Given the simulated downloads stop halfway
    When I press "Ride"
    And I press "Col de Pennes - Climb it twice!"
    And I press "Download"
    Then the route details read "Downloading: 50 %"
    When the simulated download goes on
    Then the route details offer a "Go" button
    And the media storage holds the route "video-source-vangestel/col-de-pennes" titled "Col de Pennes - Climb it twice!"
    And the media storage holds no downloaded package
    When I press "Go"
    Then the "activity" screen is shown
    And the ride was requested in the world "ui-world-video/landscape" on the route "video-source-vangestel/col-de-pennes"

  Scenario: Progress changes only the downloading route
    Given the simulated downloads stop halfway
    When I press "Ride"
    And I press "Col de Pennes - Climb it twice!"
    And I press "Download"
    Then the route details read "Downloading: 50 %"
    When the simulated download goes on
    Then the route details offer a "Go" button
    And after the start only "video-source-vangestel/col-de-pennes" of the "route.offer" state changed, in at least 3 steps

  Scenario: A downloaded route stays on the device
    When I press "Ride"
    And I press "Col de Pennes - Climb it twice!"
    And I press "Download"
    Then the route details offer a "Go" button
    When ridrs restarted
    And I reload the UI
    And I press "Ride"
    And I press "Col de Pennes - Climb it twice!"
    Then the route details offer a "Go" button

  Scenario: A failed download says why and can be tried again
    Given the simulated downloads fail with "The server could not be reached"
    When I press "Ride"
    And I press "Col de Pennes - Climb it twice!"
    And I press "Download"
    Then the route details read "Download failed: The server could not be reached"
    And the route details offer no "Go" button
    Given the simulated downloads work again
    When I press "Download"
    Then the route details offer a "Go" button

  Scenario: A downloaded route can be removed from the device
    When I press "Ride"
    And I press "Col de Pennes - Climb it twice!"
    And I press "Download"
    Then the route details offer a "Go" button
    When I press "Remove from this device"
    Then the route details read "Not on this device yet: 11.2 GB to download"
    And the media storage holds no route "video-source-vangestel/col-de-pennes"

  Scenario: A download can be cancelled
    Given the simulated downloads stop halfway
    When I press "Ride"
    And I press "Col de Pennes - Climb it twice!"
    And I press "Download"
    Then the route details read "Downloading: 50 %"
    When I press "Cancel download"
    Then the route details read "Not on this device yet: 11.2 GB to download"
    And the route details offer a "Download" button
    And the media storage holds no route "video-source-vangestel/col-de-pennes"

  Scenario: The route card downloads, shows the progress and cancels
    Given the simulated downloads stop halfway
    When I press "Ride"
    Then the route "Col de Pennes - Climb it twice!" reads "11.2 GB"
    When I press "Download Col de Pennes - Climb it twice!"
    Then the route "Col de Pennes - Climb it twice!" reads "50 %"
    When I press "Cancel download of Col de Pennes - Climb it twice!"
    Then the route "Col de Pennes - Climb it twice!" reads "11.2 GB"
    And the route "Col de Pennes - Climb it twice!" does not read "%"
    When I press "Download Col de Pennes - Climb it twice!"
    And the simulated download goes on
    Then the route "Col de Pennes - Climb it twice!" does not read "GB"
    And the route card "Col de Pennes - Climb it twice!" offers no download
