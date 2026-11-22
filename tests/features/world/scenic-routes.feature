Feature: Video routes from ridrs Scenic
  The app ships no catalog of video routes. The video source `video-source-scenic` reads the ride
  catalog of ridrs Scenic (docs/formats/scenic-ride-catalog-v1.md) through `net.http` and offers
  each of its routes as a key of the app state `route.offer` (ADR 0068). It keeps the last catalog
  in the app files, so that the routes are there at once and without a network, and asks again
  with its ETag. A route that leaves the catalog goes, unless it is on the device. A route that the
  former Van Gestel source downloaded keeps its download.

  No scenario reaches the real ridrs Scenic: it is simulated, serving the catalog of
  tests/fixtures/scenic and the files of content/vangestel; the downloads are simulated too.

  Background:
    Given the ridrs plugins "video-source-scenic, download-ride-package, data-archive-node, storage-media-node" together with the simulated downloads

  Scenario: The routes of ridrs Scenic are offered
    When the host has started
    Then the video source "video-source-scenic" offers 23 routes
    And the route offer "video-source-scenic/vg-col-de-pennes" is titled "Col de Pennes - Climb it twice!"
    And the route offer "video-source-scenic/vg-col-de-pennes" is "fetchable"
    And ridrs Scenic was asked for its ride catalog

  Scenario: Without a network the routes of the last catalog are offered
    Given the host has started
    And the video source "video-source-scenic" offers 23 routes
    And ridrs Scenic cannot be reached
    When ridrs restarted
    Then the video source "video-source-scenic" offers 23 routes

  Scenario: Without a network and without an earlier catalog no route is offered
    Given ridrs Scenic cannot be reached
    When the host has started
    Then the video source "video-source-scenic" offers 0 routes

  Scenario: A catalog is asked for again with its ETag
    Given the host has started
    And the video source "video-source-scenic" offers 23 routes
    When ridrs restarted
    Then ridrs Scenic was asked for its ride catalog with the ETag of the last one
    And the video source "video-source-scenic" offers 23 routes

  Scenario: A route that leaves the catalog goes, unless it is on the device
    Given the host has started
    And the UI bridge calls "route.fetch" with '{"key":"video-source-scenic/vg-col-de-pennes"}'
    And the route offer "video-source-scenic/vg-col-de-pennes" is "ready"
    And ridrs Scenic no longer lists "vg-col-de-pennes" and "vg-source-1"
    When ridrs restarted
    Then the video source "video-source-scenic" offers 22 routes
    And the route offer "video-source-scenic/vg-col-de-pennes" is "ready"
    And there is no route offer "video-source-scenic/vg-source-1"

  Scenario: A route the former Van Gestel source downloaded keeps its download
    Given the media storage holds the route "col-de-pennes" downloaded by the former Van Gestel source
    When the host has started
    Then the route offer "video-source-scenic/vg-col-de-pennes" is "ready"
    And the media storage holds no route "video-source-vangestel/col-de-pennes"
