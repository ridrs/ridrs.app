@ui
Feature: During a workout the power and cadence gauges mark their targets on the scale
  While a ride's workout is active, the power gauge and the cadence gauge show what the current
  step asks of them on their scales: a radial spotlight wedge expanding to a signal-orange outer
  arc with a fused inward-pointing triangle at the target's centre (Spotlight 3). While a gauge
  marks a workout target on its scale, its FTP and average triangles are hidden so the target has
  the rim to itself; the average number at the bottom stays. When the workout moves from one step
  to the next, the target area does not jump, but glides along the scale to the new target.

  Here the workout is 5 times (4 minutes at 288 W with 95–105 rpm, 4 minutes at 125 W) for an
  athlete with an FTP of 250 W.

  Background:
    Given the ridrs plugins "metric-power, metric-cadence, metric-heart-rate, ui-main-screen, ui-activity-screen, ui-hud-gauges, profile-local" together with a test device plugin "test-device"
    And the athlete profile on this device holds an FTP of 250 W and an LTHR of 170 bpm
    And the host has started
    And the ridrs UI is shown

  Scenario: The power and cadence gauges mark the step's targets on the scale and hide the other triangles
    Given a ride with the workout "VO2max 5×4" starts for an athlete with an FTP of 250 W
    And the gauges are shown
    When "test-device" publishes a power measurement of 200 W from device "trainer-1"
    And "test-device" publishes a cadence measurement of 90 rpm from device "trainer-1"
    And "test-device" publishes a heart-rate measurement of 150 bpm from device "hrm-1"
    And the workout player reports step 1 of the workout
    Then the power gauge marks the target at 288 on its scale
    And the cadence gauge marks the target from 95 to 105 on its scale
    And the power gauge marks no FTP
    And the power gauge marks no average on its scale
    And the power gauge shows the average "200"
    And the heart-rate gauge marks its average at 150 on its scale
    And everything the power gauge draws is fully opaque
    And everything the cadence gauge draws is fully opaque

  Scenario: Moving to the next workout step glides the target along the scale instead of jumping
    Given a ride with the workout "VO2max 5×4" starts for an athlete with an FTP of 250 W
    And the gauges are shown
    And the workout player reports step 1 of the workout
    And 1 second goes by
    When the workout player reports step 2 of the workout
    Then the power gauge marks the target at 288 on its scale
    When 100 milliseconds go by
    Then the power gauge target is moving between 288 and 125 on its scale
    When 400 milliseconds go by
    Then the power gauge marks the target at 125 on its scale
    And the cadence gauge marks no target on its scale

  Scenario: Changing the workout's intensity scales the target power on the scale and leaves the cadence target alone
    Given a ride with the workout "VO2max 5×4" starts for an athlete with an FTP of 250 W
    And the gauges are shown
    And the workout player reports step 1 of the workout
    When the workout's intensity changes to 110 %
    And 1 second goes by
    Then the power gauge marks the target at 317 on its scale
    And the cadence gauge marks the target from 95 to 105 on its scale

  Scenario: Once the workout is finished the target indicators disappear and the FTP and average triangles return
    Given a ride with the workout "VO2max 5×4" starts for an athlete with an FTP of 250 W
    And the gauges are shown
    And "test-device" publishes a power measurement of 200 W from device "trainer-1"
    And the workout player reports step 1 of the workout
    Then the power gauge marks the target at 288 on its scale
    And the cadence gauge marks the target from 95 to 105 on its scale
    When the workout player reports the workout finished
    Then the power gauge marks no target on its scale
    And the cadence gauge marks no target on its scale
    And the power gauge marks the FTP at 250 on its scale
    And the power gauge marks its average at 200 on its scale
