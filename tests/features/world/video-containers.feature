@phase-10
Feature: A video route plays whatever container its video comes in
  A route's video is the file its control file names, with its own extension: video2gpx can put
  a video into a package as it is, without converting it to MP4. The video world reads MP4, M4V
  and QuickTime files by their sample table and Matroska and WebM files by their cues, so a long
  video is never read in full before the ride: only the samples from the keyframe at or before
  the shown time on (ADR 0101).

  Scenario Outline: The video world reads a <container> video
    Given the test pattern as <file>
    When the video world opens the video
    Then the video is <codec> of 64 × 48 pixels
    And the frame at 1.2 s is decoded from the keyframe at 1 s on
    And the video world showed the frame at 1.2 s

    Examples:
      | container | file              | codec |
      | MP4       | test-pattern.mp4  | avc1  |
      | QuickTime | test-pattern.mov  | avc1  |
      | Matroska  | test-pattern.mkv  | avc1  |
      | WebM      | test-pattern.webm | vp09  |

  Scenario: A Matroska video is not read in full before the ride
    Given the 20 s test pattern as long-test-pattern.webm
    When the video world opens the video
    And the video world shows the frame at 15.2 s
    Then the video world read less than half of the file

  Scenario: A PQ WebM video is recognised from its container
    Given the test pattern as pq-test-pattern.webm
    When the video world opens the video
    Then it shows the opened video on the HDR canvas

  Scenario: A file that is no video in a known container is refused with a reason
    Given a file that starts with the bytes of a PNG picture
    When the video world opens the video
    Then opening the video fails with "is neither MP4 nor Matroska"
