@training @workout
Feature: A workout is exported as intervals.icu text and read back the same
  The intervals.icu exporter of `@ridrs/workout` writes the text syntax of intervals.icu
  (structured-workouts.md, sections 9 and 10): watts as `200w`, zones as `Z2`, ramps as `ramp`,
  cadence as `rpm`. Read back with the importer of the same syntax, it gives the same workout.
  What the syntax cannot express is written as near as it can, with a warning.

  Scenario: Text is exported as it was written and read back the same
    Given the intervals.icu text to export:
      """
      Warmup
      - Warm up 10m ramp 50-75% 85rpm intensity=warmup

      Main set 3x
      - 5m 200-220w 95-105rpm
      - 3m Z2

      - 20m 88-94%
      - 5m Z2 HR
      - 10m 80-85% LTHR
      - 2km 140-150bpm
      - 1m30s freeride 90rpm
      - 10s maxeffort
      - 33^Stand up <!> 5m 75% HR
      - 5m RPE 4 Keep it easy
      - 5m ramp 65-45% intensity=cooldown
      """
    When it is imported, exported as intervals.icu text and imported again
    Then the export is exactly the text
    And both imports give the same workout
    And the export has no warnings

  Scenario: What the text syntax cannot express is warned about
    Given the canonical workout to export:
      """
      {
        "format": "ridrs-workout", "version": 1, "id": "w", "name": "W", "sport": "ride", "source": { "kind": "user" },
        "steps": [
          { "kind": "interval", "id": "1", "duration": { "kind": "energy", "kilocalories": 100 },
            "effort": { "kind": "target", "primary": { "unit": "meters-per-second", "start": { "low": 8, "high": 9 } } } },
          { "kind": "repeat", "id": "2", "until": { "kind": "count", "reps": 2 }, "steps": [
            { "kind": "repeat", "id": "2.1", "until": { "kind": "count", "reps": 3 }, "steps": [
              { "kind": "interval", "id": "2.1.1", "duration": { "kind": "time", "seconds": 30 },
                "effort": { "kind": "target", "primary": { "unit": "percent-ftp", "start": { "low": 120, "high": 120 } } } }
            ] }
          ] }
        ]
      }
      """
    When it is exported as intervals.icu text
    Then the export is:
      """
      - press lap

      3x
      - 30s 120%

      3x
      - 30s 120%
      """
    And the export warns "duration-not-expressible, target-not-expressible, nested-repeat-unrolled"
