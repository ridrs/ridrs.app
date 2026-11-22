@ui
Feature: A box at the top right shows the route being ridden
  `ui-hud-gauges` adds a HUD element at the top right for the route of the ride: first its map,
  tilted a little as if seen from above and behind, with the track and where the rider is; below
  it the elevation profile with the part ridden and where the rider is along it; and the current
  gradient of the road. The map is a real map where the page can draw one (ADR 0097): OpenFreeMap's
  tiles, leaning back, the camera following the rider. Where it cannot (no WebGL, as in these
  headless scenarios, or offline), the map is the GPX track of the route's ride package (ADR 0094)
  alone, on a plane leaning back. The profile draws the route offer's elevations. A ride without a route, or a route without a track or
  elevations, shows only what it has; the gradient comes from the physics in every ride.

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-tile-ride-start, ui-activity-screen, ui-hud-gauges" together with a test device plugin "test-device"
    And the route box fixture route is installed
    And the host has started
    And the ridrs UI is shown

  Scenario: The route box sits at the top right and shows the map first, then the profile and the gradient
    When "test-device" asks to start a ride on the landscape "fixture-route-box/landscape" along the route "hill"
    Then the route box sits at the top right
    And the route box shows, in this order, "map, profile, gradient"

  Scenario: Without a map renderer the map draws the whole track alone, tilted
    When "test-device" asks to start a ride on the landscape "fixture-route-box/landscape" along the route "hill"
    Then the route map is the track alone
    And the route map draws a track of 5 points
    And the route map is tilted

  Scenario: The map marks the rider and the part ridden
    Given "test-device" asks to start a ride on the landscape "fixture-route-box/landscape" along the route "hill"
    When the world reports the rider at 46.0040, 7.0000 after 450 m
    Then the route map marks the rider
    And the route map shows 3 points of the track as ridden

  Scenario: On an out-and-back route the ridden part follows the distance ridden, not the return leg
    Given "test-device" asks to start a ride on the landscape "fixture-route-box/landscape" along the route "out-and-back"
    When the world reports the rider at 46.00201, 7.0000 after 223 m
    Then the route map shows 2 points of the track as ridden
    When the world reports the rider at 46.00201, 7.0000 after 667 m
    Then the route map shows 4 points of the track as ridden

  Scenario: The profile marks the rider along the route
    Given "test-device" asks to start a ride on the landscape "fixture-route-box/landscape" along the route "hill"
    When the physics reports a road gradient of 4.5 % after 300 m
    Then the route profile marks the rider at 25 % of the route
    And the route box shows the gradient "4.5" "%"

  Scenario: Before the first physics state the gradient is a dash
    When "test-device" asks to start a ride on the landscape "fixture-route-box/landscape" along the route "hill"
    Then the route box shows the gradient "–" "%"

  Scenario: A ride without a route shows the gradient only
    When I press "Start ride"
    Then the route box shows, in this order, "gradient"
