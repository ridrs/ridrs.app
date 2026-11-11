@training
Feature: ridrs reads the whole workout document of intervals.icu
  intervals.icu keeps the structure of a planned or library workout in its `workout_doc`
  (structured-workouts.md, sections 4.3 and 8). ridrs reads all of it into the canonical model
  without converting anything: watts stay watts, a zone stays a zone, a range is not a ramp, a
  free ride stays a free ride. What the model has no field for is kept in `extensions.intervals`.

  Here intervals.icu, the browser and the secret store are simulated. It is Wednesday 4 November
  2026.

  Background:
    Given the ridrs plugins "planner-intervals-icu" together with the simulated intervals.icu
    And intervals.icu knows the athlete "Alex Rider" with an FTP of 250 W and a weight of 72 kg
    And the local time is "2026-11-04 08:00"
    And the secret store holds a token for intervals.icu

  Scenario: A planned workout keeps its range, ramp, zone, watts, cadence and free ride
    Given intervals.icu plans "Mixed" on "2026-11-05" with the workout document:
      """
      {
        "steps": [
          { "text": "Warm up", "duration": 600, "warmup": true, "ramp": true, "power": { "units": "%ftp", "start": 50, "end": 75 } },
          { "duration": 1200, "power": { "units": "%ftp", "start": 88, "end": 94 } },
          { "reps": 3, "text": "3x", "steps": [
            { "duration": 300, "power": { "units": "w", "value": 280 }, "cadence": { "units": "rpm", "start": 95, "end": 105 } },
            { "duration": 180, "power": { "units": "power_zone", "value": 2 } }
          ] },
          { "duration": 300, "freeride": true },
          { "duration": 10, "maxeffort": true },
          { "distance": 5000, "duration": 540, "hr": { "units": "hr_zone", "value": 2 } },
          { "until_lap_press": true, "hr": { "units": "%lthr", "start": 80, "end": 85 } }
        ]
      }
      """
    When the host has started
    Then the planned workout "Mixed" of "intervals.icu" has the steps:
      """
      [
        { "kind": "interval", "id": "1", "name": "Warm up", "intensity": "warm-up", "duration": { "kind": "time", "seconds": 600 },
          "effort": { "kind": "target", "primary": { "unit": "percent-ftp", "start": { "low": 50, "high": 50 }, "end": { "low": 75, "high": 75 } } } },
        { "kind": "interval", "id": "2", "duration": { "kind": "time", "seconds": 1200 },
          "effort": { "kind": "target", "primary": { "unit": "percent-ftp", "start": { "low": 88, "high": 94 } } } },
        { "kind": "repeat", "id": "3", "until": { "kind": "count", "reps": 3 }, "extensions": { "intervals": { "doc": { "text": "3x" } } }, "steps": [
          { "kind": "interval", "id": "3.1", "duration": { "kind": "time", "seconds": 300 },
            "effort": { "kind": "target", "primary": { "unit": "watts", "start": { "low": 280, "high": 280 } },
                        "secondary": [{ "unit": "rpm", "start": { "low": 95, "high": 105 } }] } },
          { "kind": "interval", "id": "3.2", "duration": { "kind": "time", "seconds": 180 },
            "effort": { "kind": "target", "primary": { "unit": "power-zone", "start": { "low": 2, "high": 2 } } } }
        ] },
        { "kind": "interval", "id": "4", "duration": { "kind": "time", "seconds": 300 }, "effort": { "kind": "free" } },
        { "kind": "interval", "id": "5", "duration": { "kind": "time", "seconds": 10 }, "effort": { "kind": "max-effort" } },
        { "kind": "interval", "id": "6", "duration": { "kind": "distance", "meters": 5000 }, "extensions": { "intervals": { "doc": { "duration": 540 } } },
          "effort": { "kind": "target", "primary": { "unit": "hr-zone", "start": { "low": 2, "high": 2 } } } },
        { "kind": "interval", "id": "7", "duration": { "kind": "open" },
          "effort": { "kind": "target", "primary": { "unit": "percent-lthr", "start": { "low": 80, "high": 85 } } } }
      ]
      """

  Scenario: What the model has no field for is kept in the extensions of the step
    Given intervals.icu plans "Odd" on "2026-11-05" with the workout document:
      """
      {
        "steps": [
          { "duration": 60, "power": { "units": "%mmp", "value": 80, "mmp_duration": 300 }, "hidepower": true }
        ]
      }
      """
    When the host has started
    Then the planned workout "Odd" of "intervals.icu" has the steps:
      """
      [
        { "kind": "interval", "id": "1", "duration": { "kind": "time", "seconds": 60 }, "effort": { "kind": "free" },
          "extensions": { "intervals": { "doc": { "power": { "units": "%mmp", "value": 80, "mmp_duration": 300 }, "hidepower": true }, "implicitFree": true } } }
      ]
      """

  Scenario: A library workout is read as whole as a planned one
    Given intervals.icu has the library:
      | folder | name  | type | duration | load |
      | Base   | Tempo | Ride | 30m      | 40   |
    And the library workout "Tempo" of intervals.icu has the workout document:
      """
      {
        "steps": [
          { "duration": 1800, "power": { "units": "w", "start": 200, "end": 220 }, "cadence": { "units": "rpm", "value": 90 } }
        ]
      }
      """
    And the host has started
    When the library of "intervals.icu" is asked for
    Then the library workout "Tempo" of "intervals.icu" has the steps:
      """
      [
        { "kind": "interval", "id": "1", "duration": { "kind": "time", "seconds": 1800 },
          "effort": { "kind": "target", "primary": { "unit": "watts", "start": { "low": 200, "high": 220 } },
                      "secondary": [{ "unit": "rpm", "start": { "low": 90, "high": 90 } }] } }
      ]
      """
