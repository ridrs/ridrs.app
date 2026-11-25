@phase-10
Feature: A route's video plays its refined stretches with their in-between frames
  Where a rider at an easy power would see fewer than 30 frames per second, a route can hold the
  stretches of its video again with in-between frames (plan `video-zwischenframes.md`): the file
  `refine/refine.json` beside the control file names the video and, per stretch, from when to when
  in the video's time it runs, how many frames it has per frame of the video and its file below
  `refine/`. A stretch's file starts at its `from` and is a video of its own. The video world shows
  the frame at the video time of the presented distance as ever (ADR 0061), from the stretch's
  file where one covers that time and from the video everywhere else. It opens a stretch shortly
  before the rider reaches it and decodes the video ahead before the stretch ends, so the change
  costs no picture. A refinement that names another video, does not parse or names a file the
  route does not have is left out, and the video plays as it is.

  Background:
    Given the test pattern as test-pattern.mp4, 30 frames per second
    And a refined stretch from 0.5 s to 1.5 s with 4 frames per frame in refined-segment.mp4

  Scenario: Within a refined stretch the video world shows its in-between frames
    When the video world shows the times from 0.9 s to 1.1 s in steps of 0.01 s
    Then it showed the frame at 1.008 s for the time 1.01 s
    And it showed 21 different frames

  Scenario: Outside the refined stretch the video world shows the video's frames
    When the video world shows the times from 1.5 s to 1.7 s in steps of 0.01 s
    Then it showed the frame at 1.5 s for the time 1.51 s
    And it showed 7 different frames

  Scenario: The refined stretch is opened before the rider reaches it
    When the video world shows the times from 0.2 s to 0.45 s in steps of 0.05 s
    Then the next frame at 0.51 s is shown at once, the frame at 0.508 s

  Scenario: The video is decoded ahead before the refined stretch ends
    When the video world shows the times from 1.2 s to 1.45 s in steps of 0.05 s
    Then the next frame at 1.52 s is shown at once, the frame at 1.5 s

  Scenario: Back into a refined stretch after leaving it
    When the video world shows the times from 1.4 s to 1.8 s in steps of 0.05 s
    And the video world shows the times from 0.8 s to 0.9 s in steps of 0.05 s
    Then it showed the frame at 0.85 s for the time 0.85 s

  Scenario: A refined stretch whose file is no video is left out
    Given the refined stretch's file is not a video
    When the video world shows the times from 0.9 s to 1.1 s in steps of 0.01 s
    Then it showed the frame at 1.0 s for the time 1.01 s
    And the video plays without a failure

  Scenario Outline: A refinement <problem> is left out
    Given a route whose refinement <problem>
    When the video world reads the route
    Then the route has no refined stretches
    And the reason "<reason>" is logged

    Examples:
      | problem                          | reason                                  |
      | names another video              | names the video "other.mp4"             |
      | does not parse                   | refine/refine.json: not JSON            |
      | names a file the route lacks     | refine/missing.mp4 is not in the route  |
      | has overlapping stretches        | stretches overlap at 1 s                |

  Scenario: A route's refinement is read with the route
    Given a route whose refinement names its video with one stretch from 0.5 s to 1.5 s
    When the video world reads the route
    Then the route has 1 refined stretch, from 0.5 s to 1.5 s with 4 frames per frame
