@ui
Feature: The upper HUD forms a flat, lean frosted cockpit without nested boxes or double padding
  The three HUD panels along the top of the activity screen — the workout player at the top left,
  the central telemetry with its current-segment section at the top centre, and the route navigator
  at the top right — share one flat, lean visual language:
  - One flat translucent frosted glass sheet per panel (`backdrop-filter` and translucent fill) with
    the shared 12 px radius (`--ridrs-radius`) and no nested boxes, recessed chart wells or inner
    capsules.
  - Explicit, readable labels (`>= 11 px`) on every central HUD metric in snippet, summit and
    workout modes, aligned on a single outer padding grid without double padding.
  - Full-bleed map and elevation profile in the route box (`padding: 0`), and frameless elevation
    profiles whose vertical gradient mask fades cleanly to transparent (`stop-opacity="0"`) at the
    base, with the rider dot riding directly on the elevation curve.
  - Flat, borderless interval rows in the workout player on a single horizontal padding grid, with
    one high-contrast text layer on the active step.

  Background:
    Given the ridrs plugins "activity-session, metric-power, metric-cadence, ui-main-screen, ui-tile-ride-start, ui-activity-screen, ui-hud-gauges, ui-widget-workout, profile-local" together with a test device plugin "test-device"
    And the athlete profile on this device holds an FTP of 250 W and an LTHR of 170 bpm
    And the route box fixture route is installed
    And the host has started
    And the ridrs UI is shown

  Scenario: All three upper HUD panels are flat translucent glass with no nested boxes or double padding
    Given a ride with the workout "VO2max 5×4" on the route "hill" starts for an athlete with an FTP of 250 W
    When the workout player reports step 1 of the workout
    Then the upper HUD panel "widget-workout" is translucent glass with radius "var(--ridrs-radius)"
    And the upper HUD panel "ride-facts" is translucent glass with radius "var(--ridrs-radius)"
    And the upper HUD panel "route-box" is translucent glass with radius "var(--ridrs-radius)"
    And the route box bleeds its map and profile edge-to-edge with zero outer padding and no inner rounded frames
    And the workout HUD aligns its header, rows and footer on one padding grid without nested row boxes

  Scenario: During a workout step every central segment column has its own readable label on a flat transparent section
    Given a ride with the workout "VO2max 5×4" on the route "hill" starts for an athlete with an FTP of 250 W
    When the workout player reports step 1 of the workout
    And 60 seconds go by
    Then the central HUD segment section sits flat without a nested background fill
    And the central HUD metric "segment-workout-time" carries the label "Step"
    And the central HUD metric "segment-workout-power" carries the label "Target"
    And the central HUD metric "segment-workout-cadence" carries the label "Cadence"
    And the workout HUD header labels the step position with "Step"
    And the active workout HUD row renders a single text layer without split-fill duplication

  Scenario: On hilly terrain profiles are frameless, fade to transparent and carry no nested capsules
    Given "test-device" asks to start a ride on the landscape "fixture-route-box/landscape" along the route "hill"
    When the physics reports a road gradient of 4.5 % at 5 m/s after 300 m
    And the world reports the rider at 46.0027, 7.0000 and altitude 112 m after 300 m
    Then the central HUD metric "segment-gradient" carries the label "Gradient" at least 11 px high
    And the central HUD metric "segment-elevation" carries the label "Elev" at least 11 px high
    And the central segment profile sits directly in the segment section without a wrapper box and fades to transparent
    And the route profile fades its terrain to transparent and places the rider dot on the elevation curve
    And the route distance readout is flat text without a backing capsule

  Scenario: Approaching a categorised summit labels both gradient and climb gain without nested pills
    Given "test-device" asks to start a ride on the landscape "fixture-route-box/landscape" along the route "pass"
    When the physics reports a road gradient of 8.0 % at 10 m/s after 930 m
    And the world reports the rider at 46.0084, 7.0000 and altitude 173 m after 930 m
    Then the central HUD metric "segment-gradient" carries the label "Gradient" at least 11 px high
    And the central HUD metric "segment-climb" carries the label "Climb" at least 11 px high
    And the summit header items are flat text without pill backgrounds
