@ui
Feature: The route profile is a UI capability
  The elevation profile of a route is drawn by the plugin ui-route-profile (ui.route-profile) in
  two variants: small behind a route card, large with gradients in the route's details. The
  ride page and the briefing ask for it; without the plugin the ride page still shows the facts.

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-area-ride, ui-route-profile, ui-route-profile" together with a test device plugin "test-device"
    And the briefing fixture routes are installed

  Scenario: Cards and details draw their profiles through the capability
    Given the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Ride"
    Then the route card "Short loop" has a profile of its own
    When I press "Short loop"
    Then the route details draw the elevation profile of "Short loop"

  Scenario: Without the provider the route page shows no profile and the rest works
    Given the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When the plugin "ui-route-profile" is stopped
    And I press "Ride"
    Then the route card "Short loop" has no profile
    And the page offers a "Short loop" button
