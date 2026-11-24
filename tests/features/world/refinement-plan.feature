Feature: Where a route's video needs in-between frames
  A rider slower than the camera sees fewer frames per second than the video has: at a frame rate
  f and a camera speed v, a rider at speed u sees f · u / v different frames per second (ADR 0061).
  After a download, the stretches where a rider at 100 W, the lower end of an easy ride of
  100–150 W, would see fewer than 30 are computed again with in-between frames (plan
  `video-zwischenframes.md`, phase 1). The rider's speed is the steady speed on the route's
  gradient, measured over 100 m, with the physics' defaults: 75 kg and a bicycle of 10 kg, a drag
  area of 0.32 m², rolling resistance 0.004, air of 1.225 kg/m³. A stretch gets 2, 4 or 8 frames
  for each frame of the video, at most 8; a stretch where the camera stands still gets none. Gaps
  shorter than 2 s are closed, a stretch shorter than 3 s takes its neighbour's higher factor,
  each refined stretch reaches 0.5 s further either way, and none crosses a cut of the video.

  Scenario Outline: The steady speed of a rider of 85 kg at <power> W on <gradient> %
    When a rider of 85 kg rides at <power> W on a gradient of <gradient> %
    Then their steady speed is <speed> km/h to within 0.1 km/h

    Examples:
      | power | gradient | speed |
      | 100   | 0        | 26.2  |
      | 100   | 3        | 11.8  |
      | 100   | 6        | 6.7   |
      | 100   | 9        | 4.6   |
      | 150   | 6        | 9.9   |
      | 100   | -3       | 44.4  |

  Scenario: A video filmed from a bicycle needs no in-between frames on the flat
    Given a video at 30 fps filmed at 20 km/h along a road that runs
      | for  | rising |
      | 3 km | 0 m    |
    When its refinement is planned for 100 W
    Then it has 0 refined stretches

  Scenario Outline: A video filmed from a car at 40 km/h on <gradient> % gets <factor> frames per frame
    Given a video at 30 fps filmed at 40 km/h along a road that runs
      | for  | rising        |
      | 1 km | 0 m           |
      | 2 km | <rising> m    |
      | 1 km | 0 m           |
    When its refinement is planned for 100 W
    Then the middle of the climb is refined with <factor> frames per frame
    And at 100 W the rider sees at least <seen> frames per second there

    Examples:
      | gradient | rising | factor | seen |
      | 3        | 60     | 4      | 30   |
      | 6        | 120    | 8      | 30   |
      | 9        | 180    | 8      | 27   |

  Scenario: A video of 60 fps needs half as many
    Given a video at 60 fps filmed at 40 km/h along a road that runs
      | for  | rising |
      | 1 km | 0 m    |
      | 2 km | 120 m  |
      | 1 km | 0 m    |
    When its refinement is planned for 100 W
    Then the middle of the climb is refined with 4 frames per frame

  Scenario: The flat of a car video is refined as well, and the summary counts the frames
    Given a video at 30 fps filmed at 40 km/h along a road that runs
      | for  | rising |
      | 2 km | 0 m    |
    When its refinement is planned for 100 W
    Then it has 1 refined stretch
    And refined stretch 1 runs from 0 s to the end with 2 frames per frame
    And the summary counts 5400 in-between frames for 5400 frame pairs
    And at 100 W the rider sees at least 30 frames per second everywhere

  Scenario: Each refined stretch reaches 0.5 s further either way
    Given a video at 30 fps filmed at 20 km/h along a road that runs
      | for  | rising |
      | 1 km | 0 m    |
      | 1 km | 30 m   |
      | 1 km | 0 m    |
    When its refinement is planned for 100 W
    Then it has 1 refined stretch
    And refined stretch 1 begins 0.5 s before the first moment that needs it
    And refined stretch 1 ends 0.5 s after the last moment that needs it

  Scenario: A short gap between two stretches is closed
    Given a video at 30 fps filmed at 17 km/h along a road rising 2 % for 180 s, slowing to 11 km/h for 3 s after 90 s
    When its refinement is planned for 100 W
    Then the moments that need refining leave a gap of less than 2 s
    And it has 1 refined stretch

  Scenario: A longer gap keeps two stretches
    Given a video at 30 fps filmed at 17 km/h along a road rising 2 % for 180 s, slowing to 10 km/h for 3 s after 90 s
    When its refinement is planned for 100 W
    Then the moments that need refining leave a gap of more than 2 s
    And it has 2 refined stretches

  Scenario: A stretch shorter than 3 s takes its neighbour's higher factor
    Given a video at 30 fps filmed at 40 km/h along a road rising 3 % for 180 s, slowing to 20 km/h for 11 s after 90 s
    When its refinement is planned for 100 W
    Then for less than 3 s a rider would need only 2 frames per frame
    And it has 1 refined stretch
    And refined stretch 1 runs from 0 s to the end with 4 frames per frame

  Scenario: A stretch of 3 s or longer keeps its own factor
    Given a video at 30 fps filmed at 40 km/h along a road rising 3 % for 180 s, slowing to 10 km/h for 8 s after 90 s
    When its refinement is planned for 100 W
    Then it has 3 refined stretches
    And refined stretch 2 has 2 frames per frame

  Scenario: No refined stretch crosses a cut of the video
    Given a video at 30 fps filmed at 40 km/h along a road that runs
      | for  | rising |
      | 2 km | 0 m    |
    And the video is cut at 90 s
    When its refinement is planned for 100 W
    Then it has 2 refined stretches
    And refined stretch 1 ends at 90 s
    And refined stretch 2 begins at 90 s

  Scenario: Where the camera stands still, nothing is refined
    Given a video at 30 fps filmed from a car that drives 500 m at 40 km/h, stands still for 20 s and drives 500 m again on the flat
    When its refinement is planned for 100 W
    Then it has 2 refined stretches
    And no refined stretch covers the time from 47 s to 63 s

  Scenario: A step of the elevation across a jump of the track is no climb
    Given a video at 30 fps filmed at 20 km/h along a road that runs
      | for  | rising |
      | 3 km | 0 m    |
    And the track jumps 40 m up across its point at 60 s, a cut of the video
    When its refinement is planned for 100 W
    Then it has 0 refined stretches
