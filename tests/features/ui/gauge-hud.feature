@ui
Feature: An alternative HUD shows power, heart rate and cadence as analogue gauges
  `ui-hud-gauges` takes the place of `ui-hud` on the activity screen: it offers the same
  `hud/widget` extension point in the lower corners, above the ride's buttons, and adds a HUD
  element of its own at the top centre: the telemetry, three round gauges like the dials of a car. Power and heart rate also show their average
  over the ride; cadence shows its value only. The scale of each gauge is coloured by zone: power
  by the power zones of the athlete profile in watts of the FTP, heart rate by its heart rate
  zones in bpm. Cadence has no zones in the profile and is coloured by fixed cadence bands.

  The average counts every available reading while the ride runs; readings before the ride or
  while it is paused do not count, and a new ride starts from none.

  Background:
    Given the ridrs plugins "activity-session, metric-power, metric-cadence, metric-heart-rate, ui-main-screen, ui-tile-ride-start, ui-activity-screen, ui-hud-gauges, ui-widget-power-heart-rate-ratio, profile-local" together with a test device plugin "test-device"
    And the athlete profile on this device holds an FTP of 250 W and an LTHR of 170 bpm
    And the host has started
    And the ridrs UI is shown

  Scenario: The gauge HUD takes the place of the HUD and keeps its widgets
    When I press "Start ride"
    Then the slot "activity/hud" contains the contributions "ui-hud-gauges/hud, ui-hud-gauges/telemetry" in this order
    And the slot "hud/widget" contains the contributions "ui-widget-power-heart-rate-ratio/power-heart-rate-ratio" in this order
    And pointer events pass through the gauge HUD except on its gauges and widgets

  Scenario: The telemetry sits at the top centre, the widgets above the ride's buttons
    When I press "Start ride"
    Then the gauges are shown in the order "power, heart-rate, cadence"
    And the telemetry sits at the top centre
    And the widgets of the HUD keep clear of the ride's buttons

  Scenario: The gauges show the current values
    Given I press "Start ride"
    When "test-device" publishes a power measurement of 200 W from device "trainer-1"
    And "test-device" publishes a cadence measurement of 90.5 rpm from device "trainer-1"
    And "test-device" publishes a heart-rate measurement of 150 bpm from device "hrm-1"
    Then the power gauge shows "200" "W"
    And the cadence gauge shows "91" "rpm"
    And the heart-rate gauge shows "150" "bpm"

  # A metric takes a measurement only once per time: time passes between readings.
  @fake-timers
  Scenario: Power and heart rate show their average over the ride, cadence none
    Given I press "Start ride"
    And the gauges are shown
    When "test-device" publishes a power measurement of 100 W from device "trainer-1"
    And "test-device" publishes a heart-rate measurement of 140 bpm from device "hrm-1"
    And 1 second passes
    And "test-device" publishes a power measurement of 0 W from device "trainer-1"
    And "test-device" publishes a heart-rate measurement of 161 bpm from device "hrm-1"
    And 1 second passes
    And "test-device" publishes a power measurement of 350 W from device "trainer-1"
    And "test-device" publishes a cadence measurement of 90 rpm from device "trainer-1"
    Then the power gauge shows the average "150"
    And the heart-rate gauge shows the average "151"
    And the cadence gauge shows no average

  @fake-timers
  Scenario: Readings before the ride and while it is paused do not count
    Given "test-device" published a power measurement of 500 W from device "trainer-1"
    And 1 second passes
    And I press "Start ride"
    And the gauges are shown
    And "test-device" published a power measurement of 200 W from device "trainer-1"
    And 1 second passes
    And I press "Pause"
    And "test-device" published a power measurement of 600 W from device "trainer-1"
    And 1 second passes
    When I press "Resume"
    And "test-device" publishes a power measurement of 100 W from device "trainer-1"
    Then the power gauge shows "100" "W"
    And the power gauge shows the average "150"

  Scenario: The power scale shows the power zones in watts of the FTP
    When I press "Start ride"
    Then the power gauge has 7 zones on its scale
    And zone 1 of the power gauge runs from 0 to 138
    And zone 4 of the power gauge runs from 225 to 263
    And zone 7 of the power gauge runs from 375 to the end of the scale

  Scenario: The heart rate scale shows the heart rate zones in bpm
    When I press "Start ride"
    Then the heart-rate gauge has 7 zones on its scale
    And zone 2 of the heart-rate gauge runs from 138 to 151

  Scenario: The gauge marks the zone of the current value
    Given I press "Start ride"
    When "test-device" publishes a power measurement of 240 W from device "trainer-1"
    And "test-device" publishes a heart-rate measurement of 120 bpm from device "hrm-1"
    Then the power gauge marks zone 4
    And the heart-rate gauge marks zone 1

  Scenario: Without data the gauges say so instead of showing zero
    When I press "Start ride"
    Then the power gauge is unavailable
    And the heart-rate gauge is unavailable
    And the cadence gauge is unavailable

  Scenario: A lost device shows a dash and why, not the last value
    Given I press "Start ride"
    And "test-device" published a power measurement of 200 W from device "trainer-1"
    When "test-device" reports device "trainer-1" as "reconnecting"
    Then the power gauge is unavailable with the reason "disconnected"
