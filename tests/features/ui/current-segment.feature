@ui
Feature: The central HUD extends with the current segment below time, distance and speed
  Below the ride's time, distance and speed at the top centre, `ui-hud-gauges` shows a context-aware
  current-segment section separated by a light divider:
  - On a hilly route snippet: a fine-grained local elevation profile, the live gradient (without a
    mini slope icon), and the local elevation.
  - On a categorised climb or summit approach: the climb-only local profile (descent stripped,
    ending at the summit crest), the countdown on the left starting 10 seconds before arrival, the
    peak name and category on the right, the live gradient, and the climbed / total climb gain in
    hm (e.g. `523 / 1244 hm`).
  - During a structured workout step: big target watts, target cadence (when set), remaining and
    total step time, no elevation gradient, minimal text, and a fine-segmented progress ring around
    the entire central HUD card.
  - On a flat road with no active climb or workout step: the extension hides completely.

  Background:
    Given the ridrs plugins "activity-session, metric-power, metric-cadence, ui-main-screen, ui-tile-ride-start, ui-activity-screen, ui-hud-gauges, profile-local" together with a test device plugin "test-device"
    And the athlete profile on this device holds an FTP of 250 W and an LTHR of 170 bpm
    And the route box fixture route is installed
    And the host has started
    And the ridrs UI is shown

  Scenario: On a hilly route the central HUD shows the local elevation profile, gradient and elevation
    Given "test-device" asks to start a ride on the landscape "fixture-route-box/landscape" along the route "hill"
    When the physics reports a road gradient of 4.5 % at 5 m/s after 300 m
    And the world reports the rider at 46.0027, 7.0000 and altitude 112 m after 300 m
    Then the current segment is shown in "snippet" mode
    And the current segment draws a fine-grained local elevation profile
    And the current segment shows the gradient "+4.5" "%"
    And the current segment shows the local elevation "112" "m"

  Scenario: On a flat road the central HUD hides the current-segment extension
    Given "test-device" asks to start a ride on the landscape "fixture-route-box/landscape" along the route "flat"
    When the physics reports a road gradient of 0 % at 8 m/s after 300 m
    Then the current segment is not shown

  Scenario: Approaching a summit shows a 10-second countdown on the left, peak and category on the right, climb-only profile and climb gain
    Given "test-device" asks to start a ride on the landscape "fixture-route-box/landscape" along the route "pass"
    When the physics reports a road gradient of 8.0 % at 10 m/s after 930 m
    And the world reports the rider at 46.0084, 7.0000 and altitude 173 m after 930 m
    Then the current segment is shown in "summit" mode
    And the summit countdown on the left shows "7 s"
    And the summit header on the right shows "Route des Crêtes" and "Cat 2"
    And the current segment draws a climb-only local profile ending at the summit
    And the current segment shows the gradient "+8.0" "%"
    And the current segment shows the climb gain "73 / 80 hm"

  Scenario: During a workout step the central HUD shows big target watts, target cadence, remaining and total time and a segmented perimeter ring without gradient
    Given a ride with the workout "VO2max 5×4" starts for an athlete with an FTP of 250 W
    And the workout player reports step 1 of the workout
    When 60 seconds go by
    Then the current segment is shown in "workout" mode
    And the workout segment shows target power "288" "W"
    And the workout segment shows target cadence "95–105" "rpm"
    And the workout segment shows step time "3:00" and "/ 4:00"
    And the current segment shows no gradient
    And the central HUD draws a workout progress ring with 36 segments and 9 filled
    When the workout player reports the workout finished
    Then the current segment is not shown
