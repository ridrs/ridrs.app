@ui
Feature: What a quality of a download is
  A downloader may name each quality's resolution, frame rate and whether it is HDR (ADR 0105):
  the quality dialog shows them, SDR where it is not HDR, and the size where it is known.

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-activity-screen, ui-landscape-demo, ui-area-ride, ui-route-profile, video-source-scenic, data-archive-node, storage-media-node" together with the simulated downloads
    And a test downloader offers the qualities "2160p60 HDR, 2160p60, 1080p60 (recommended), 720p30" for ride packages
    And the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown

  Scenario: Each quality names its resolution, frame rate and whether it is HDR
    When I press "Ride"
    And I press "Col de Pennes - Climb it twice!"
    And I press "Download"
    Then the route details offer the qualities "2160p · 60 fps · HDR, 2160p · 60 fps · SDR, 1080p · 60 fps · SDR, 720p · 30 fps · SDR"
    And the focus is on "1080p · 60 fps · SDR"
