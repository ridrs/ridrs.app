Feature: A ride's screenshot holds what the window shows
  The native snapshot of the web view cannot draw a see-through WebGPU canvas: it fills it with
  black (ADR 0102). While a screenshot is taken the app says so (`ride.screenshot-capture`), the
  UI draws such canvases another way (the gauges show their SVG), and only then is the snapshot
  taken. Afterwards the UI goes back to how it was, also when the snapshot failed.

  Scenario: The UI is told before the snapshot and after it
    Given the recordings hold no screenshots
    When a screenshot of the ride started at "2026-11-11T12:29:54.500Z" is taken
    Then the steps were "capture on, settle, snapshot recordings/ride-20261111T122954Z-screenshot_00.jpg, capture off"
    And the screenshot is "recordings/ride-20261111T122954Z-screenshot_00.jpg"

  Scenario: A failed snapshot still gives the UI back
    Given the recordings hold no screenshots
    And the snapshot fails
    When a screenshot of the ride started at "2026-11-11T12:29:54.500Z" is taken
    Then the screenshot failed
    And the steps were "capture on, settle, snapshot recordings/ride-20261111T122954Z-screenshot_00.jpg, capture off"

  Scenario: Two screenshots asked for at once are taken one after the other, with their own numbers
    Given the recordings hold no screenshots
    When two screenshots of the ride started at "2026-11-11T12:29:54.500Z" are asked for at once
    Then the steps were "capture on, settle, snapshot recordings/ride-20261111T122954Z-screenshot_00.jpg, capture off, capture on, settle, snapshot recordings/ride-20261111T122954Z-screenshot_01.jpg, capture off"
