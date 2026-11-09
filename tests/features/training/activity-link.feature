@training @ui
Feature: A ridrs://activity link opens the debriefing of that ride
  The relay's page for an activity bounces to ridrs://activity/<external_id> (ADR 0079). The
  provider of deep links checks the shape and that the ride exists on this device, and says so in
  the app state "app.link"; the main screen then opens the debriefing of that session. Links to
  rides that do not exist, or of another shape, never reach the state.

  Background:
    Given the ridrs plugins "activity-session, recording-session, export-fit, ui-main-screen, ui-tile-ride-start, ui-activity-screen, ui-debriefing, planner-intervals-icu, ui-training-plan" together with the simulated intervals.icu
    And a test link plugin
    And the local time is "2026-11-04 08:00"
    And the secret store holds a token for intervals.icu
    And the host has started
    And the ridrs UI is shown

  Scenario: A link to a ride of this device opens its debriefing
    When I press "Start ride"
    And I press "Finish ride"
    And I press "Save"
    Then the "main" screen is shown
    When a link opens the last ride
    Then the "debriefing" screen is shown

  Scenario: The ride is named in a link by the external id of its upload, which has no colon
    When I press "Start ride"
    And I press "Finish ride"
    And the debriefing shows "Save uploads the ride to intervals.icu"
    And I press "Save"
    Then the upload of the last ride has an external id the relay accepts
    And the link to the last ride names it by that external id
