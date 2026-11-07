@fake-timers
Feature: A video download can be cancelled
  A route's download is long work: `route.fetch` starts it, the offer's key in `route.offer`
  reports it, and `route.cancel` stops it (ADR 0068: long work is a call, state and a cancel
  call). A cancelled route can be downloaded again; what was fetched so far stays for it.

  Background:
    Given the ridrs plugins "video-source-vangestel, video-import-incyclist, data-archive-node, storage-media-node" together with the simulated downloads
    And the host has started
    And the simulated downloads stop halfway

  Scenario: Cancelling a download on its way
    Given the UI bridge called "route.fetch" with '{"key":"video-source-vangestel/col-de-pennes"}'
    And the route offer "video-source-vangestel/col-de-pennes" is "fetching"
    When the UI bridge calls "route.cancel" with '{"key":"video-source-vangestel/col-de-pennes"}'
    Then the call resolved with '{}'
    And the route offer "video-source-vangestel/col-de-pennes" is "fetchable"
    And the media storage holds no route "video-source-vangestel/col-de-pennes"

  Scenario: A cancelled route can be downloaded again
    Given the UI bridge called "route.fetch" with '{"key":"video-source-vangestel/col-de-pennes"}'
    And the UI bridge called "route.cancel" with '{"key":"video-source-vangestel/col-de-pennes"}'
    And the route offer "video-source-vangestel/col-de-pennes" is "fetchable"
    And the simulated download goes on
    When the UI bridge calls "route.fetch" with '{"key":"video-source-vangestel/col-de-pennes"}'
    Then the route offer "video-source-vangestel/col-de-pennes" is "ready"
    And the media storage holds the route "video-source-vangestel/col-de-pennes" titled "Col de Pennes - Climb it twice!"

  Scenario: Cancelling a route that is not on its way changes nothing
    When the UI bridge calls "route.cancel" with '{"key":"video-source-vangestel/col-de-pennes"}'
    Then the call resolved with '{}'
    And the route offer "video-source-vangestel/col-de-pennes" is "fetchable"
