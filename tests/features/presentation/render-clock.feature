@phase-7 @fake-timers
Feature: The GUI renders on its own clock
  Frames come at the display's rate, the physics at 100 Hz. Each frame shows the
  physics 60 ms in the past; the frame rate never changes the physics.

  Background:
    Given the ridrs physics plugins and "ui-landscape-demo" together with a test device plugin "test-device" and a probe plugin "test-ui"
    And the host has started

  Scenario: Sixty frames and one hundred steps per second
    Given a presentation client renders at 60 frames per second
    And "test-ui" published "activity.start-requested"
    When "test-device" delivers only power 200 W every 0.25 s for 1 second
    Then 60 frames were rendered
    And the state at "+1000 ms" is step 100

  Scenario: A frame shows the physics interpolated 60 ms in the past
    Given a presentation client renders at 60 frames per second
    And "test-ui" published "activity.start-requested"
    When "test-device" delivers only power 200 W every 0.25 s for 2 seconds
    Then the frame at "+1017 ms" presented a speed of 6.65 km/h and a distance of 1.00 m "interpolated"

  Scenario: The first frames of a ride show nothing
    Given a presentation client renders at 60 frames per second
    And "test-ui" published "activity.start-requested"
    When 0.1 s pass
    Then the frame at "+33 ms" presented nothing

  Scenario: After the finish the last state is held
    Given a presentation client renders at 60 frames per second
    And "test-ui" published "activity.start-requested"
    And "test-device" delivered only power 200 W every 0.25 s for 5 seconds
    When "test-ui" publishes "activity.finish-requested"
    And 0.5 s pass
    Then the frame at "+5500 ms" presented a speed of 16.32 km/h and a distance of 14.79 m "held"

  Scenario Outline: Rendering does not change the physics (<fps> FPS)
    Given a presentation client renders at <fps> frames per second
    And "test-ui" published "activity.start-requested"
    When "test-device" delivers only power 200 W every 0.25 s for 10 seconds
    Then the virtual speed at "+10 s" is 22.24 km/h
    And the virtual distance at "+10 s" is 41.94 m

    Examples:
      | fps |
      | 0   |
      | 30  |
      | 60  |
      | 144 |

  Scenario: A failing frame handler does not stop the frames or the physics
    Given a presentation client renders at 60 frames per second
    And a second frame handler of "ui-landscape-demo" throws on every frame
    And "test-ui" published "activity.start-requested"
    When "test-device" delivers only power 200 W every 0.25 s for 1 second
    Then 60 frames were rendered
    And a client failure of "ui-landscape-demo" was reported once
    And the state at "+1000 ms" is step 100
