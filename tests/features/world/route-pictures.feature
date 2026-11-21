Feature: A route's pictures: the catalog's overlay and a small tile picture
  ridrs Scenic offers, per route, files that improve its package (ADR 0094, phase 6): its
  picture in full size, under the name its package gives it (`preview.jpg`, or the PNG the control
  file names in `<preview>`). On download they are copied into the route's folder, where they win
  over the package's own; at start a downloaded route gets the catalog's current ones, found by
  their hashes. A card shows a small picture: ridrs Scenic offers one for each route, and a route on
  the device gets its own, made from its picture when it is downloaded or imported (`data.picture`),
  kept as the hidden `.tile.jpg` in its folder.

  Here the downloads and the making of small pictures are simulated; the sources and the media
  storage are the real plugins on a media folder of the scenario.

  Background:
    Given the ridrs plugins "video-source-scenic, video-source-local, data-archive-node, storage-media-node" together with the simulated downloads
    And pictures are made smaller by the simulated picture provider

  Scenario: A route of the catalog shows the catalog's small picture on its card and its full one in its details
    Given the host has started
    Then the route offer "video-source-scenic/vg-col-de-pennes" shows the tile picture "scenic/vg/col-de-pennes/thumbnail.jpg"
    And the route offer "video-source-scenic/vg-col-de-pennes" shows the full picture "scenic/vg/col-de-pennes/overlay/preview.jpg"

  Scenario: A downloaded route gets the catalog's overlay and a small picture made from it
    Given the host has started
    When the UI bridge calls "route.fetch" with '{"key":"video-source-scenic/vg-col-de-pennes"}'
    Then the route offer "video-source-scenic/vg-col-de-pennes" is "ready"
    And the route folder "video-source-scenic/vg-col-de-pennes" holds "FR_Test.gpx, FR_Test.mp4, FR_Test.xml, preview.jpg"
    And the route folder "video-source-scenic/vg-col-de-pennes" holds the catalog's "preview.jpg" of "col-de-pennes"
    And the route offer "video-source-scenic/vg-col-de-pennes" shows the full picture "video-source-scenic/vg-col-de-pennes/preview.jpg"
    And the route offer "video-source-scenic/vg-col-de-pennes" shows the tile picture "video-source-scenic/vg-col-de-pennes/.tile.jpg"
    And the small picture of "video-source-scenic/vg-col-de-pennes" is made from its "preview.jpg"

  Scenario: A route downloaded before the catalog changed gets the catalog's overlay at start
    Given the media storage holds the Van Gestel route "col-de-pennes" with the overlay of an older catalog
    When the host has started
    Then the route offer "video-source-scenic/vg-col-de-pennes" is "ready"
    And the route folder "video-source-scenic/vg-col-de-pennes" holds the catalog's "preview.jpg" of "col-de-pennes"
    And the small picture of "video-source-scenic/vg-col-de-pennes" is made from its "preview.jpg"

  Scenario: An own route on the device without a small picture gets one at start
    Given the media storage holds the own route folder "col-de-test" unpacked from an Incyclist package with a picture
    When the host has started
    Then the route offer "video-source-local/col-de-test" is "ready"
    And the route offer "video-source-local/col-de-test" shows the tile picture "video-source-local/col-de-test/.tile.jpg"
    And the small picture of "video-source-local/col-de-test" is made from its "preview.jpg"
