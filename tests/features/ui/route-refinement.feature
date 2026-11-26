@ui
Feature: The route details say how far a route's in-between frames are
  After its download a video route gets in-between frames where a rider at 100 W would see fewer
  than 30 frames per second (ADR 0110). Its details say how far that is, and the rider can cancel
  it and start it again; the route can be ridden all the while. Cancel and the start again are
  on the ride path: buttons, as Go is (AGENTS.md rule 12).

  Here the downloads are simulated and a test interpolator stands in for the Mac's frame rate
  conversion; it stops halfway until told to go on.

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-activity-screen, ui-landscape-demo, ui-area-ride, ui-route-profile, video-source-scenic, download-ride-package, data-archive-node, storage-media-node, video-refine" together with the simulated downloads
    And a test interpolator computes in-between frames
    And the test interpolator stops halfway
    And the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown

  Scenario: The details say how far the in-between frames are, and when they are done
    When I press "Ride"
    And I press "Col de Pennes - Climb it twice!"
    And I press "Download"
    Then the route details read "Computing in-between frames for slow riding: 50 %"
    And the route details offer a "Go" button
    When the test interpolator goes on
    Then the route details read "With in-between frames for slow riding"

  Scenario: The rider cancels the in-between frames and starts them again
    When I press "Ride"
    And I press "Col de Pennes - Climb it twice!"
    And I press "Download"
    Then the route details read "Computing in-between frames for slow riding: 50 %"
    When I press "Cancel in-between frames"
    Then the route details read "In-between frames for slow riding: cancelled"
    When the test interpolator works again at once
    And I press "Compute in-between frames"
    Then the route details read "With in-between frames for slow riding"

  Scenario: The global actions show while in-between frames are computed, until they are done
    When I press "Ride"
    And I press "Col de Pennes - Climb it twice!"
    And I press "Download"
    Then the global actions read "In-between frames 50 %"
    And the in-between frames in the global actions are labelled "In-between frames for Col de Pennes - Climb it twice!: 50 %, the end is being estimated"
    When the test interpolator goes on
    Then the global actions show no in-between frames

  Scenario: The rider pauses the in-between frames in the global actions and resumes them
    When I press "Ride"
    And I press "Col de Pennes - Climb it twice!"
    And I press "Download"
    Then the global actions read "In-between frames 50 %"
    When I press "Pause in-between frames"
    Then the global actions read "In-between frames paused"
    And the route details read "In-between frames for slow riding: cancelled"
    When the test interpolator works again at once
    And I press "Resume in-between frames"
    Then the route details read "With in-between frames for slow riding"
    And the global actions show no in-between frames
