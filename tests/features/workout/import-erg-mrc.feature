Feature: Import of ERG and MRC files
  Points (minute, value) become one step per section, rebuilt exactly: the same value is steady,
  a slope is a ramp, the same minute twice is a jump. ERG holds watts, MRC percent of FTP, and
  neither is converted.

  Scenario: An ERG file in watts is imported in watts
    Given a workout text file "sections.erg":
      """
      [COURSE HEADER]
      VERSION = 2
      UNITS = ENGLISH
      DESCRIPTION = Two sections
      FILE NAME = sections
      FTP = 250
      MINUTES WATTS
      [END COURSE HEADER]
      [COURSE DATA]
      0.00	100
      5.00	100
      5.00	200
      10.00	250
      [END COURSE DATA]
      """
    When the workout text file is imported
    Then the import succeeds with 1 workout
    And the imported workout is named "sections"
    And the imported workout has the reference FTP 250
    And in the imported workout, step "1" lasts 300 seconds
    And in the imported workout, step "1" holds 100 watts
    And in the imported workout, step "2" lasts 300 seconds
    And in the imported workout, step "2" ramps from 200 to 250 watts

  Scenario: An MRC file in percent is imported in percent
    Given a workout text file "ramp.mrc":
      """
      [COURSE HEADER]
      VERSION = 2
      UNITS = ENGLISH
      DESCRIPTION = Ramp
      FILE NAME = ramp
      MINUTES PERCENT
      [END COURSE HEADER]
      [COURSE DATA]
      0.00	50
      10.50	75
      [END COURSE DATA]
      """
    When the workout text file is imported
    Then in the imported workout, step "1" lasts 630 seconds
    And in the imported workout, step "1" ramps from 50 to 75 percent-ftp

  Scenario: Course text becomes cues of the step they fall into
    Given a workout text file "text.mrc":
      """
      [COURSE HEADER]
      MINUTES PERCENT
      [END COURSE HEADER]
      [COURSE DATA]
      0.00	60
      5.00	60
      5.00	90
      10.00	90
      [END COURSE DATA]
      [COURSE TEXT]
      30	Easy does it	10
      330	Go!	5
      [END COURSE TEXT]
      """
    When the workout text file is imported
    Then in the imported workout, step "1" has the cue "Easy does it" at 30 seconds
    And in the imported workout, step "2" has the cue "Go!" at 30 seconds

  Scenario: Header lines the model has no field for are kept
    Given a workout text file "kept.erg":
      """
      [COURSE HEADER]
      VERSION = 2
      UNITS = METRIC
      MINUTES WATTS
      [END COURSE HEADER]
      [COURSE DATA]
      0	100
      1	100
      [END COURSE DATA]
      """
    When the workout text file is imported
    Then the erg extensions of the workout have "header[0].key" equal to "VERSION"
    And the erg extensions of the workout have "header[1].value" equal to "METRIC"

  Scenario: Minutes that go backwards are refused with the line
    Given a workout text file "back.erg":
      """
      [COURSE HEADER]
      MINUTES WATTS
      [END COURSE HEADER]
      [COURSE DATA]
      0	100
      5	100
      3	120
      [END COURSE DATA]
      """
    When the workout text file is imported
    Then the import is refused with the code "points-out-of-order"
    And the import has a reason

  Scenario: A file without course data is refused
    Given a workout text file "empty.mrc":
      """
      this is not a course file
      """
    When the workout text file is imported
    Then the import is refused with the code "no-course-data"
