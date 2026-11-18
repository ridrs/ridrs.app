Feature: A ride's screenshots are named after the ride
  A screenshot taken during a ride is kept with the ride's recordings, named after the ride's
  start in UTC like its recording, and numbered from 00 for each ride: the first free number
  after the highest one of that ride. Screenshots of other rides do not count.

  Scenario: The first screenshot of a ride is number 00
    Given the recordings hold no screenshots
    When a screenshot of the ride started at "2026-11-11T12:29:54.500Z" is named
    Then its path is "recordings/ride-20261111T122954Z-screenshot_00.jpg"

  Scenario: The next screenshot comes after the highest one of the same ride
    Given the recordings hold "ride-20261111T122954Z-screenshot_00.jpg, ride-20261111T122954Z-screenshot_02.jpg, ride-20261111T122954Z-3f2a9c1d.ridrs"
    When a screenshot of the ride started at "2026-11-11T12:29:54.500Z" is named
    Then its path is "recordings/ride-20261111T122954Z-screenshot_03.jpg"

  Scenario: Screenshots of other rides do not count
    Given the recordings hold "ride-20261110T080000Z-screenshot_04.jpg"
    When a screenshot of the ride started at "2026-11-11T12:29:54.500Z" is named
    Then its path is "recordings/ride-20261111T122954Z-screenshot_00.jpg"

  Scenario: After 99 the numbers go on with three digits
    Given the recordings hold "ride-20261111T122954Z-screenshot_99.jpg"
    When a screenshot of the ride started at "2026-11-11T12:29:54.500Z" is named
    Then its path is "recordings/ride-20261111T122954Z-screenshot_100.jpg"
