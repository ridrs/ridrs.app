@ui
Feature: The upper HUD forms a unified frosted cockpit across workout, central telemetry and route
  The three HUD panels along the top of the activity screen — the workout player at the top left,
  the central telemetry with its current-segment deck at the top centre, and the route navigator at
  the top right — share one visual language with the gauges below:
  - Translucent frosted dark glass (`backdrop-filter` and translucent background) with the same
    16 px outer radius (`--ridrs-radius-lg`), instead of mixing opaque page cards with custom boxes.
  - Explicit, readable labels (`>= 11 px`) on every central HUD metric in snippet, summit and
    workout modes, so no figure sits unlabelled beneath an unrelated column header.
  - Vertical gradient-shaded elevation profiles in both the central segment strip and the route
    box, with the route profile's rider marker riding on the elevation curve itself and the
    remaining distance backed by a dark capsule so it stays readable over the terrain line.
  - A single high-contrast text layer in the workout player's active interval row (never sliced
    across two colours by a moving fill), with a labelled step counter in its header.

  Background:
    Given the ridrs plugins "activity-session, metric-power, metric-cadence, ui-main-screen, ui-tile-ride-start, ui-activity-screen, ui-hud-gauges, ui-widget-workout, profile-local" together with a test device plugin "test-device"
    And the athlete profile on this device holds an FTP of 250 W and an LTHR of 170 bpm
    And the route box fixture route is installed
    And the host has started
    And the ridrs UI is shown

  Scenario: All three upper HUD panels use translucent frosted glass and the shared large radius
    Given a ride with the workout "VO2max 5×4" on the route "hill" starts for an athlete with an FTP of 250 W
    When the workout player reports step 1 of the workout
    Then the upper HUD panel "widget-workout" is translucent glass with radius "var(--ridrs-radius-lg)"
    And the upper HUD panel "ride-facts" is translucent glass with radius "var(--ridrs-radius-lg)"
    And the upper HUD panel "route-box" is translucent glass with radius "var(--ridrs-radius-lg)"

  Scenario: During a workout step every central segment column has its own readable label and the workout row uses a single readable text layer
    Given a ride with the workout "VO2max 5×4" on the route "hill" starts for an athlete with an FTP of 250 W
    When the workout player reports step 1 of the workout
    And 60 seconds go by
    Then the central HUD metric "segment-workout-time" carries the label "Step"
    And the central HUD metric "segment-workout-power" carries the label "Target"
    And the central HUD metric "segment-workout-cadence" carries the label "Cadence"
    And the workout HUD header labels the step position with "Step"
    And the active workout HUD row renders a single text layer without split-fill duplication

  Scenario: On hilly terrain and climbs every central segment metric is labelled at readable size and profiles are gradient-shaded
    Given "test-device" asks to start a ride on the landscape "fixture-route-box/landscape" along the route "hill"
    When the physics reports a road gradient of 4.5 % at 5 m/s after 300 m
    And the world reports the rider at 46.0027, 7.0000 and altitude 112 m after 300 m
    Then the central HUD metric "segment-gradient" carries the label "Gradient" at least 11 px high
    And the central HUD metric "segment-elevation" carries the label "Elev" at least 11 px high
    And the central segment profile shades its terrain with a vertical gradient
    And the route profile shades its terrain with a vertical gradient
    And the route profile places the rider dot on the elevation curve, not pinned to the top edge
    And the route distance readout has its own dark backing capsule

  Scenario: Approaching a categorised summit labels both gradient and climb gain
    Given "test-device" asks to start a ride on the landscape "fixture-route-box/landscape" along the route "pass"
    When the physics reports a road gradient of 8.0 % at 10 m/s after 930 m
    And the world reports the rider at 46.0084, 7.0000 and altitude 173 m after 930 m
    Then the central HUD metric "segment-gradient" carries the label "Gradient" at least 11 px high
    And the central HUD metric "segment-climb" carries the label "Climb" at least 11 px high
