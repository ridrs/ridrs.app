Feature: A downloaded route is refined with in-between frames
  After a video route is downloaded, `video-refine` computes the stretches of its video where a
  rider at 100 W would see fewer than 30 frames per second (`planRefinement`) again with
  in-between frames, by the device's `video.interpolate` (ADR 0110). Each stretch goes to its
  own file below `refine/`; `refine/refine.json` lists those done (ADR 0109), and the route's
  source offers them with the route's files (`route.refresh`). The route can be ridden all the
  while. A refinement waits while a ride runs and goes on after it, can be cancelled and started
  again, and is not computed again once it is done.

  The simulated package's track runs a minute at 18 km/h up 4 %: a rider at 100 W rides it at
  under 10 km/h, so its 25 frames per second need 4 frames per frame throughout.

  Background:
    Given the ridrs plugins "video-source-scenic, download-ride-package, data-archive-node, storage-media-node, video-refine" together with the simulated downloads
    And a test interpolator computes in-between frames

  Scenario: A route is refined after its download
    Given the host has started
    When the UI bridge calls "route.fetch" with '{"key":"video-source-scenic/vg-col-de-pennes","option":"package"}'
    Then the refinement of "video-source-scenic/vg-col-de-pennes" is done with 1 stretch
    And the test interpolator was asked for 0 s to 60 s of "videos/video-source-scenic/vg-col-de-pennes/FR_Test.mp4" with 4 frames per frame
    And the route "video-source-scenic/vg-col-de-pennes" has the refined stretch from 0 s to 60 s with 4 frames per frame
    And the route offer "video-source-scenic/vg-col-de-pennes" names the files of its refinement

  Scenario: The refinement says how far it is
    Given the test interpolator stops halfway
    And the host has started
    When the UI bridge calls "route.fetch" with '{"key":"video-source-scenic/vg-col-de-pennes","option":"package"}'
    Then the refinement of "video-source-scenic/vg-col-de-pennes" is refining at 50 %
    When the test interpolator goes on
    Then the refinement of "video-source-scenic/vg-col-de-pennes" is done with 1 stretch

  Scenario: A refined route is not refined again
    Given the route "video-source-scenic/vg-col-de-pennes" was downloaded and refined
    When the host has started again
    Then the refinement of "video-source-scenic/vg-col-de-pennes" is done with 1 stretch
    And the test interpolator was asked for no stretch since

  Scenario: A cancelled refinement keeps nothing half-done and starts again
    Given the test interpolator stops halfway
    And the host has started
    When the UI bridge calls "route.fetch" with '{"key":"video-source-scenic/vg-col-de-pennes","option":"package"}'
    And the refinement of "video-source-scenic/vg-col-de-pennes" is refining at 50 %
    And the UI bridge calls "video.refine" with '{"key":"video-source-scenic/vg-col-de-pennes","action":"cancel"}'
    Then the refinement of "video-source-scenic/vg-col-de-pennes" is skipped because "The refinement was cancelled"
    And the route "video-source-scenic/vg-col-de-pennes" has no half-done refined stretch
    When the test interpolator works again at once
    And the UI bridge calls "video.refine" with '{"key":"video-source-scenic/vg-col-de-pennes","action":"start"}'
    Then the refinement of "video-source-scenic/vg-col-de-pennes" is done with 1 stretch

  Scenario: A refinement waits while a ride runs
    Given the test interpolator stops halfway
    And the host has started
    When the UI bridge calls "route.fetch" with '{"key":"video-source-scenic/vg-col-de-pennes","option":"package"}'
    And the refinement of "video-source-scenic/vg-col-de-pennes" is refining at 50 %
    And a ride starts
    Then the refinement of "video-source-scenic/vg-col-de-pennes" is waiting
    When the test interpolator works again at once
    And the ride ends
    Then the refinement of "video-source-scenic/vg-col-de-pennes" is done with 1 stretch

  Scenario: A failing refinement says why
    Given the test interpolator fails with "The video cannot be decoded"
    And the host has started
    When the UI bridge calls "route.fetch" with '{"key":"video-source-scenic/vg-col-de-pennes","option":"package"}'
    Then the refinement of "video-source-scenic/vg-col-de-pennes" failed because "The video cannot be decoded"
    And the route offer "video-source-scenic/vg-col-de-pennes" is "ready"

  Scenario: A route whose video lies in its package is not refined
    Given the simulated downloads serve packages with a stored video
    And the host has started
    When the UI bridge calls "route.fetch" with '{"key":"video-source-scenic/vg-col-de-pennes","option":"package"}'
    Then the refinement of "video-source-scenic/vg-col-de-pennes" is skipped because "Its video lies in route.ride"

  Scenario: Without a way to compute in-between frames the route plays as it is
    Given the device cannot compute in-between frames
    And the host has started
    When the UI bridge calls "route.fetch" with '{"key":"video-source-scenic/vg-col-de-pennes","option":"package"}'
    Then the refinement of "video-source-scenic/vg-col-de-pennes" is skipped because "This device cannot compute in-between frames"
    And the route offer "video-source-scenic/vg-col-de-pennes" is "ready"
