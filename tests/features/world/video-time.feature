@phase-10
Feature: The video moves smoothly along the GPX track
  The video world shows the frame at the video time of the presented distance (ADR 0061). That
  time comes from the route's GPX track: its distance over time, sampled every 0.5 s and smoothed
  with a Gaussian kernel of σ = 4 s (ADR 0062). A rider at a steady speed sees a picture that
  neither surges nor brakes at the track's points, and the picture still moves exactly as far as
  the physics moved.

  Scenario: The camera speeds up at one point without a step in the picture
    Given a track filmed with a point every second at 20 km/h for 120 s and then at 30 km/h for 120 s
    When a rider rides it at a steady 20 km/h
    Then the video's rate changes by at most 2 % from one 0.5-s sample to the next

  Scenario: A jittery track moves smoothly
    Given a track filmed with a point every second at a steady 20 km/h for 600 s, each point off by up to 2 m with the seed 13
    When a rider rides it at a steady 20 km/h
    Then the video's rate changes by at most 5 % per second in 95 % of the seconds

  Scenario: The video never runs backwards
    Given a track filmed with a point every second at a steady 20 km/h for 600 s, each point off by up to 2 m with the seed 7
    When a rider rides it at a steady 20 km/h
    Then the video time never decreases

  Scenario: The ride goes on where the camera moves again
    Given a track filmed with a point every second at 20 km/h for 120 s, three points standing still until 180 s and again at 20 km/h for 120 s
    Then at the standstill's distance the video time lies between 164 s and 180 s
    And 1 m before the standstill's distance the video time is at most 136 s

  Scenario: The video time holds before the start and beyond the end, after the start frame
    Given a track filmed with a point every second at 20 km/h for 120 s
    And the track starts 2 s into the video
    Then 10 m before the start the video time is 2 s
    And at the start the video time is 2 s
    And 50 m beyond the end the video time is 122 s
