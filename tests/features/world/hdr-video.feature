@phase-10
Feature: An HDR video route is shown in HDR
  The video world takes a video's colour from its container, not from the decoded frames: WebKit
  labels decoded VP9 as BT.709 whatever it is. A PQ video with BT.2020 primaries and matrix goes to
  the HDR canvas, where the video world converts it itself; BT.2408's reference white (203 cd/m²)
  is shown as SDR white and brighter light above it (ADR 0091).

  Scenario: A PQ video is recognised from its container
    Given the test video tagged as PQ with BT.2020 primaries and matrix
    When the video world reads its index
    Then it shows the video on the HDR canvas

  Scenario: A video without colour information stays SDR
    Given the test video without colour information
    When the video world reads its index
    Then it shows the video on the SDR canvas

  Scenario: Reference white is SDR white, highlights are brighter
    Then a PQ signal of 203 cd/m² is shown at 1.00 times SDR white
    And a PQ signal of 1000 cd/m² is shown at more than 4.9 times SDR white

  Scenario: Limited-range white and black of BT.2020 become full white and black
    Then the limited-range code values 235, 128, 128 give R'G'B' 1.000, 1.000, 1.000
    And the limited-range code values 16, 128, 128 give R'G'B' 0.000, 0.000, 0.000
