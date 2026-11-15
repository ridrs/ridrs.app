@phase-10
Feature: The video plays up to the route's start while the rider gets ready
  A route can start later in its video than at its first frame. Then the video world plays the
  video from its first frame as soon as it is loaded and holds at the route's start until the
  rider rolls. Once the rider rolls, the picture follows the distance from the route's start,
  wherever the lead-in was. The rider rolls with their first pedal stroke, the same barrier that
  starts the ride's time and keeps the rider from rolling down a descent.

  Background:
    Given a track filmed with a point every second at 20 km/h for 120 s
    And the track starts 20 s into the video

  Scenario: The lead-in plays from the video's first frame
    When the video has played 5 s with the rider at the start
    Then the video shows the time 5 s

  Scenario: The lead-in holds at the route's start until the rider rolls
    When the video has played 30 s with the rider at the start
    Then the video shows the time 20 s

  Scenario: Pedalling during the lead-in plays from the route's start
    Given the video has played 5 s with the rider at the start
    When the rider has rolled 1 m after 6 s
    Then the video shows a time between 20 s and 20.5 s

  Scenario: Once rolled, the picture stays on the route, also where the rider stands
    Given the video has played 5 s with the rider at the start
    And the rider has rolled 100 m after 25 s
    When the rider still stands at 100 m after 200 s
    Then the video shows a time between 37 s and 39 s

  Scenario: A continued ride shows the route, not the lead-in
    When the rider stands at 100 m when the video is loaded
    Then the video shows a time between 37 s and 39 s

  Scenario: Before the ride's first state the video shows its first frame
    When the video has played 5 s before the ride's first state
    Then the video shows the time 0 s

  Scenario: A route that starts at the video's first frame has no lead-in
    Given the track starts 0 s into the video
    When the video has played 5 s with the rider at the start
    Then the video shows the time 0 s
