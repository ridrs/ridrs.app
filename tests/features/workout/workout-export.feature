@workout
Feature: Exporting a workout to ZWO, FIT, ERG, MRC, TCX and intervals.icu text
  A workout of the canonical format is written to any of the six formats (structured-workouts.md,
  section 9). An export to the format a workout came from restores what its extensions kept, so
  that import, export and import again give the same workout. Values are converted only where the
  target format cannot hold a unit (watts for ZWO and MRC, % FTP for ERG and TCX), always with a
  warning; steps a format cannot hold (heart rate, distance, lap button, bounds) become time steps;
  an export that needs an FTP and has none is refused with its reason. FIT and the intervals.icu
  text lose nothing but the extensions of other formats.

  The sources are the hand-written test vectors of packages/workout/test-vectors; the official
  Garmin FIT SDK, a devDependency of the tests only, reads every exported FIT workout.

  Scenario Outline: A <format> file comes back as the same workout after import, export and import
    Given the test vector "<file>" is imported
    When the workout is exported to <format>
    Then the workout export succeeds
    And importing the workout export again gives the same workout

    Examples:
      | format    | file                           |
      | zwo       | zwo/sweet-spot-3x12.zwo        |
      | zwo       | zwo/distance-and-unknown-parts.zwo |
      | fit       | fit/repeat-cadence.fit         |
      | fit       | fit/targets.fit                |
      | erg       | erg/threshold-2x10.erg         |
      | erg       | erg/irregular.erg              |
      | mrc       | mrc/over-unders.mrc            |
      | tcx       | tcx/bike-intervals.tcx         |
      | tcx       | tcx/unusual-targets-and-steps.tcx |
      | intervals | intervals/sweet-spot.txt       |

  Scenario Outline: A canonical <format> file comes back as the same text
    Given the test vector "<file>" is imported
    When the workout is exported to <format>
    Then the workout export text is the text of the test vector

    Examples:
      | format | file                    |
      | zwo    | zwo/sweet-spot-3x12.zwo |
      | erg    | erg/threshold-2x10.erg  |
      | mrc    | mrc/over-unders.mrc     |

  Scenario: A workout in watts is converted to % FTP for ZWO and the conversion is warned
    Given the workout from the intervals.icu text:
      """
      - 10m 200w
      - 5m 250w
      """
    When the workout is exported to zwo with an FTP of 250 W
    Then the workout export succeeds
    And the workout export text contains 'Power="0.8"'
    And the workout export warns "watts-to-percent"

  Scenario: A workout in % FTP is refused for ERG without an FTP, with its reason
    Given the workout from the intervals.icu text:
      """
      - 10m 80%
      """
    When the workout is exported to erg
    Then the workout export is refused with the code "ftp-required"
    And the workout export refusal says why

  Scenario: A workout in % FTP is converted to watts for ERG with an FTP
    Given the workout from the intervals.icu text:
      """
      - 10m 80%
      """
    When the workout is exported to erg with an FTP of 250 W
    Then the workout export text contains "0.00<TAB>200"
    And the workout export warns "percent-to-watts"

  Scenario: A heart rate step, a lap-button step and a distance step become time steps in ZWO
    Given the workout from the intervals.icu text:
      """
      - 10m 75%
      - 5m 140-150bpm
      - press lap 60%
      - 2km 70%
      """
    When the workout is exported to zwo with an FTP of 250 W
    Then the workout export text contains '<FreeRide Duration="300"/>'
    And the workout export text contains '<SteadyState Duration="240" Power="0.7"/>'
    And the workout export warns "target-to-free-ride"
    And the workout export warns "duration-estimated"

  Scenario: Repeats are written out for ERG and cadence is dropped
    Given the workout from the intervals.icu text:
      """
      3x
      - 1m 100% 90rpm
      - 1m 50%
      """
    When the workout is exported to erg with an FTP of 200 W
    Then the workout export text contains "6.00<TAB>100"
    And the workout export warns "repeats-unrolled"
    And the workout export warns "cadence-dropped"

  Scenario: A ramp is written as small steps in FIT and read by the official FIT SDK
    Given the workout from the intervals.icu text:
      """
      - 10m ramp 50-75%
      - press lap 60%
      """
    When the workout is exported to fit
    Then the workout export succeeds
    And the workout export warns "ramp-stepped"
    And the official FIT SDK decodes the workout export without errors and with 21 steps

  Scenario Outline: The official FIT SDK reads the FIT export of <file>
    Given the test vector "<file>" is imported
    When the workout is exported to fit
    Then the official FIT SDK decodes the workout export without errors and with <steps> steps

    Examples:
      | file                         | steps |
      | fit/repeat-cadence.fit       | 5     |
      | fit/durations.fit            | 10    |
      | zwo/sweet-spot-3x12.zwo      | 41    |
