@fake-timers
Feature: The physics reads the terrain from the spatial layer
  A world feeds the terrain ahead as inputs, in metres along the path, anchored at the
  physics odometer; the spatial layer interpolates between the samples. The physics reads
  it once per step at the previous distance and subscribes to no data event. Until the
  first window of a ride arrives, the ride is flat on asphalt, as expected. A gap after
  that is reported once, while the last road holds.

  Background:
    Given the ridrs physics plugins together with a test device plugin "test-device" and a probe plugin "test-ui"

  @phase-10
  Scenario: Step 0 rides on the default, the next step on the world's first window
    Given a mock world "test-world" feeds the terrain ahead with a constant gradient of 5 % when the ride starts
    And the host has started
    When "test-ui" publishes "activity.start-requested"
    And 0.25 s pass
    Then step 0 rode on a gradient of 0 % on "asphalt"
    And step 1 rode on a gradient of 5 % on "asphalt"
    And no "terrain-preview-missing" diagnostic was reported

  Scenario: Between two samples the gradient is interpolated linearly
    Given a mock world "test-world" feeds the terrain ahead with the gradients "0, 10" % 10 m apart when the ride starts
    And the host has started
    And "test-ui" published "activity.start-requested"
    When "test-device" delivers only power 200 W every 0.25 s for 3 seconds
    Then the gradient of every step is 1 % per metre of the distance one step before
    And the virtual distance at "+3 s" is between 1 m and 10 m

  # Headless is this case: without a UI no window ever arrives (ADR 0044, amended 2026-11-04).
  Scenario: Without a world the ride stays flat on asphalt
    Given the host has started
    And "test-ui" published "activity.start-requested"
    When "test-device" delivers only power 200 W every 0.25 s for 10 seconds
    Then the virtual speed at "+10 s" is 22.24 km/h
    And the gradient at "+10 s" is 0 %
    And the road at "+10 s" is "asphalt"
    And no "terrain-preview-missing" diagnostic was reported
    And no "physics-step-failed" diagnostic was reported

  @phase-10
  Scenario: A gap after the first window is reported once, with the reader's reason
    Given a mock world "test-world" feeds the terrain ahead with a constant gradient of 5 % when the ride starts
    And the host has started
    And "test-ui" published "activity.start-requested"
    And "test-device" delivered only power 200 W every 0.25 s for 2 seconds
    When "test-world" feeds a window that starts 1000 m ahead
    And "test-device" delivers only power 200 W every 0.25 s for 2 seconds
    Then a "terrain-preview-missing" diagnostic was reported once, because of "outside-window"
    And the gradient at "+4 s" is 5 %

  Scenario: When the window has run out, the physics holds its last sample
    Given a mock world "test-world" feeds a single window of 20 m with a constant gradient of 5 % when the ride starts
    And the host has started
    And "test-ui" published "activity.start-requested"
    When "test-device" delivers only power 200 W every 0.25 s for 60 seconds
    Then the virtual speed at "+60 s" is 14.90 km/h
    And the gradient at "+60 s" is 5 %
    And a "terrain-preview-missing" diagnostic was reported once, just after 20 m

  @phase-10
  Scenario Outline: 200 W settle at <speed> km/h on flat <surface>
    Given a mock world "test-world" feeds flat "<surface>" ahead when the ride starts
    And the host has started
    And "test-ui" published "activity.start-requested"
    When "test-device" delivers only power 200 W every 0.25 s for 180 seconds
    Then the virtual speed at "+180 s" is <speed> km/h
    And the road at "+180 s" is "<surface>"

    Examples:
      | surface | speed |
      | asphalt | 34.22 |
      # ADR 0044 estimated "about 32.2" from v ≈ 8.95 m/s; the exact root of
      # 200 = 0.008 · 85 · 9.81 · v + ½ · 1.225 · 0.32 · v³ is 8.946 m/s = 32.21 km/h.
      | gravel  | 32.21 |

  @phase-10
  Scenario: A window without a surface rides on asphalt
    Given a mock world "test-world" feeds the terrain ahead with a constant gradient of 0 % when the ride starts
    And the host has started
    And "test-ui" published "activity.start-requested"
    When "test-device" delivers only power 200 W every 0.25 s for 10 seconds
    Then the road at "+10 s" is "asphalt"
    And no "terrain-preview-missing" diagnostic was reported
