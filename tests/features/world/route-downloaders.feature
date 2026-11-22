Feature: A downloader for each kind of download
  A video source lists routes; how a route comes onto the device is the business of a downloader
  (ADR 0105). Each route of a source has a kind of download, and a downloader plugin provides the
  capability `route.downloader` for the kinds it can fetch. The source hands each route to the
  downloader of its kind: `route.download-options`, `route.fetch`, `route.cancel` and
  `route.remove` reach the source, which owns the route's key, and go on to that downloader. A
  route whose kind no downloader fetches is not offered.

  The routes of ridrs Scenic are packages (`ride-package`): `download-ride-package` fetches them
  in one quality only.

  Scenario: A package is downloaded by the package downloader, in its one quality
    Given the ridrs plugins "video-source-scenic, download-ride-package, data-archive-node, storage-media-node" together with the simulated downloads
    And the host has started
    When the UI bridge calls "route.download-options" with '{"key":"video-source-scenic/vg-col-de-pennes"}'
    Then the call resolved with '{"options":[{"id":"package","label":"Package","size":11213923126}]}'
    When the UI bridge calls "route.fetch" with '{"key":"video-source-scenic/vg-col-de-pennes","option":"package"}'
    Then the route offer "video-source-scenic/vg-col-de-pennes" is "ready"

  Scenario: Without a downloader of their kind the routes are not offered
    Given the ridrs plugins "video-source-scenic, data-archive-node, storage-media-node" together with the simulated downloads
    When the host has started
    Then the video source "video-source-scenic" offers 0 routes

  Scenario: Another downloader of the kind gets the routes and the chosen quality
    Given the ridrs plugins "video-source-scenic, data-archive-node, storage-media-node" together with the simulated downloads
    And a test downloader offers the qualities "2160p, 1080p (recommended), 720p" for ride packages
    And the host has started
    When the UI bridge calls "route.fetch" with '{"key":"video-source-scenic/vg-col-de-pennes","option":"720p"}'
    Then the test downloader was asked for the route "video-source-scenic/vg-col-de-pennes" in "720p"
    And the route offer "video-source-scenic/vg-col-de-pennes" is "fetching"
