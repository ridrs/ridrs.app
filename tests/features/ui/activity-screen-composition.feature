@phase-3 @ui
Feature: Composing the activity screen from independent plugins
  The activity screen only offers extension points. Landscape, HUD and widgets
  are separate plugins that plug in - and the HUD is painted over the landscape.

  The shell runs in-process with the real host, as in the native app, rendered into a
  headless DOM. A headless DOM has no layout engine, so the layering is asserted on the
  declared stacking (positions, z-order, pointer events) instead of hit-testing; the
  visual result is part of the manual check of apps/native.

  Background:
    Given the ridrs plugins "activity-session, metric-power, metric-cadence, ui-main-screen, ui-tile-ride-start, ui-activity-screen, ui-landscape-demo, ui-hud, ui-widget-power, ui-widget-cadence" together with a test device plugin "test-device"
    And the host has started
    And the ridrs UI is shown

  Scenario: The application starts on the main screen
    Then the "main" screen is shown
    And the page offers a "Start ride" button

  Scenario: Starting a ride opens the activity screen
    When I press "Start ride"
    Then the "activity" screen is shown

  Scenario: The activity screen is assembled from contributions
    When I press "Start ride"
    Then the slot "activity/landscape" contains the contribution "ui-landscape-demo/landscape"
    And the slot "activity/hud" contains the contribution "ui-hud/hud"
    And the slot "hud/widget" contains the contributions "ui-widget-power/power, ui-widget-cadence/cadence" in this order

  Scenario: The HUD is painted over the landscape
    When I press "Start ride"
    Then the HUD layer covers the same area as the landscape layer
    And the HUD layer is stacked above the landscape layer
    And pointer events pass through the HUD except on its widgets
    And the "Finish ride" button is stacked above the HUD layer

  Scenario: The screen does not know its contributors
    Then the manifest and the client of "ui-activity-screen" mention none of "ui-hud, ui-landscape-demo, ui-widget-power, ui-widget-cadence"

  Scenario: Power and cadence are shown during a ride
    Given I press "Start ride"
    When "test-device" publishes a power measurement of 200 W from device "trainer-1"
    And "test-device" publishes a cadence measurement of 90 rpm from device "trainer-1"
    Then the power widget shows "200" "W"
    And the cadence widget shows "90" "rpm"

  Scenario: Values are rounded to whole numbers
    Given I press "Start ride"
    When "test-device" publishes a cadence measurement of 90.5 rpm from device "trainer-1"
    Then the cadence widget shows "91" "rpm"

  Scenario: Zero is a real value
    Given I press "Start ride"
    When "test-device" publishes a power measurement of 0 W from device "trainer-1"
    Then the power widget shows "0" "W"

  # Deviation from the brief: metric plugins publish nothing before their first measurement
  # (Phase 2 scenarios pin that), so the widgets follow rule 5.2 "before the first event".
  Scenario: Without data the widgets say so instead of showing zero
    When I press "Start ride"
    Then the power widget is unavailable without a reason
    And the cadence widget is unavailable without a reason

  Scenario: A lost device shows dashes, not the last value
    Given I press "Start ride"
    And "test-device" published a power measurement of 200 W from device "trainer-1"
    And "test-device" published a cadence measurement of 90 rpm from device "trainer-1"
    When "test-device" reports device "trainer-1" as "reconnecting"
    Then the power widget is unavailable with the reason "disconnected"
    And the cadence widget is unavailable with the reason "disconnected"

  Scenario: Values that arrived before the ride are shown immediately
    Given "test-device" published a power measurement of 180 W from device "trainer-1"
    When I press "Start ride"
    Then the power widget shows "180" "W"

  Scenario: Finishing the ride returns to the main screen
    Given I press "Start ride"
    When I press "Finish ride"
    Then the "main" screen is shown

  Scenario: Reloading the UI during a ride returns to the activity screen
    Given I press "Start ride"
    When I reload the UI
    Then the "activity" screen is shown

  Scenario: A second window sees the same ride
    Given I press "Start ride"
    When a second ridrs UI is shown
    Then the "activity" screen is shown in the second UI

  Scenario: Stopping a widget plugin removes only its widget
    Given I press "Start ride"
    When the plugin "ui-widget-cadence" is stopped
    Then the cadence widget is no longer shown
    And the power widget is still shown

  Scenario: Starting a widget plugin later adds its widget
    Given the plugin "ui-widget-cadence" is stopped
    And I press "Start ride"
    When the plugin "ui-widget-cadence" is started
    Then the cadence widget is shown after the power widget

  Scenario: A broken contribution does not break the screen
    Given the plugin directory "tests/fixtures/plugins/broken-widget" is added and its plugin "fixture-ui-broken-widget" is started
    When I press "Start ride"
    Then the power widget is still shown
    And the cadence widget is still shown
    And the host reported a "client-load-failure" problem for plugin "fixture-ui-broken-widget"
