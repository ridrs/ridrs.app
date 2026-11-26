@phase-10
Feature: A video with a broken stretch plays on after it
  A downloaded video can hold a stretch the decoder cannot read, e.g. a damaged segment of the
  download. WebCodecs closes its decoder at the first such sample. The video world then holds the
  last picture only while the rider is within the broken stretch: it leaves out the samples from
  the keyframe the broken sample belongs to up to the next keyframe, decodes with a new decoder
  from there, and plays on. Only a decoder that fails again and again without a frame in between
  stops the video for the ride.

  Scenario: The picture holds over a broken stretch and the video plays on after it
    Given a 10 s video with a keyframe every second whose samples from 3.2 s to 3.5 s cannot be decoded
    When the rider rides through the video from 2 s to 6 s
    Then the picture followed the rider from 2 s to 3 s
    And it held the last frame before 3 s from 3 s to 4 s
    And the picture followed the rider from 4 s to 6 s
    And the video did not stop
    And the video world told that the stretch from the keyframe at 3 s was left out

  Scenario: A rider who stops within a broken stretch sees the picture from before it
    Given a 10 s video with a keyframe every second whose samples from 3.2 s to 3.5 s cannot be decoded
    When the rider rides through the video from 2 s to 3.6 s
    And the rider stays at 3.6 s
    Then the picture is the last frame before 3 s
    And the video did not stop

  Scenario: A video the decoder cannot read at all stops with a reason
    Given a 10 s video with a keyframe every second whose samples from 0 s to 10 s cannot be decoded
    When the rider rides through the video from 0 s to 6 s
    Then the video stopped
