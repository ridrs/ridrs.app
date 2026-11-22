@ui
Feature: Choosing the quality of a download
  A downloader may offer a route in several qualities (ADR 0105). Download asks the route's source
  for them (`route.download-options`) in a dialog that says so while they are read and offers Try
  again when they could not be: with one, the download starts at once, as for the packages of
  ridrs Scenic (features "Downloading a video route"); with several, the dialog asks which, with
  the recommended one first in the focus, each with its resolution, frame rate and whether it is
  HDR where the downloader names them, and `route.fetch` names the one chosen.
  Choosing a route is on the ride path: arrows, Enter and Back alone (AGENTS.md rule 12).

  Here a test downloader takes the place of the package downloader and offers three qualities.

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-activity-screen, ui-landscape-demo, ui-area-ride, ui-route-profile, video-source-scenic, data-archive-node, storage-media-node" together with the simulated downloads
    And a test downloader offers the qualities "2160p, 1080p (recommended), 720p" for ride packages
    And the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown

  Scenario: Download asks for the quality, the recommended one in the focus
    When I press "Ride"
    And I press "Col de Pennes - Climb it twice!"
    And I press "Download"
    Then the route details offer the qualities "2160p, 1080p, 720p"
    And the focus is on "1080p"
    And the test downloader was asked for no route
    When I press "720p"
    Then the test downloader was asked for the route "video-source-scenic/vg-col-de-pennes" in "720p"
    And the route details read "Downloading: 0 %"

  Scenario: With the keyboard alone a quality is chosen
    When I press "Ride"
    And I press "Col de Pennes - Climb it twice!"
    And I press "Download"
    And I move the focus to "2160p"
    And I press Enter
    Then the test downloader was asked for the route "video-source-scenic/vg-col-de-pennes" in "2160p"

  Scenario: Back leaves the choice without a download
    When I press "Ride"
    And I press "Col de Pennes - Climb it twice!"
    And I press "Download"
    And I press Back
    Then the route details offer a "Download" button
    And the route details offer no "1080p" button
    And the test downloader was asked for no route

  Scenario: Download on a route card opens the route's details with the choice
    When I press "Ride"
    And I press "Download Col de Pennes - Climb it twice!"
    Then the route details offer the qualities "2160p, 1080p, 720p"
    And the focus is on "1080p"

  Scenario: While the qualities are read, the dialog says so
    Given the test downloader takes its time to read the qualities
    When I press "Ride"
    And I press "Col de Pennes - Climb it twice!"
    And I press "Download"
    Then the quality dialog reads "Reading the qualities…"
    When the test downloader has read the qualities
    Then the route details offer the qualities "2160p, 1080p, 720p"
    And the focus is on "1080p"

  Scenario: Qualities that could not be read are read again on Try again
    Given the test downloader cannot read the qualities once: "yt-dlp is out of date"
    When I press "Ride"
    And I press "Col de Pennes - Climb it twice!"
    And I press "Download"
    Then the quality dialog reads "The qualities could not be read: yt-dlp is out of date"
    And the focus is on "Try again"
    When I press "Try again"
    Then the route details offer the qualities "2160p, 1080p, 720p"
