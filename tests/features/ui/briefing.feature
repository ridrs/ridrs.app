@ui @training
Feature: The briefing before every ride
  Every ride starts through the briefing (structured-workouts.md, section 11). It asks only for
  what the way in has not fixed: Today's "Start ride" asks for the route (or a free ride) and the
  workout (or none); the next workout fixes the workout; a route's "Go" and "Ride again" fix the
  route. It shows a preview (route profile above workout chart), a summary, whether the trainer and
  the heart rate band are paired, remembers the last choice, and starts the ride with the workout
  resolved with the athlete profile of now. The briefing is on the ride path: arrows, Enter and
  Back alone (AGENTS.md rule 12).

  Here intervals.icu, the browser and the secret store are simulated; the routes and the paired
  devices are fixtures. It is Wednesday 4 November 2026.

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-briefing, ui-route-profile, ui-workout-chart, ui-garage, ui-devices, ui-area-ride, ui-route-profile, ui-landscape-demo, ui-area-training, library-ridrs, ui-area-me, ui-settings, profile-local, planner-intervals-icu, ui-training-plan, ui-workout-details" together with the simulated intervals.icu
    And the briefing fixture routes are installed
    And intervals.icu knows the athlete "Alex Rider" with an FTP of 250 W and a weight of 72 kg
    And the local time is "2026-11-04 08:00"
    And the secret store holds a token for intervals.icu

  Scenario: Start ride asks for the route and the workout, and Back returns to Today
    Given the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Start ride"
    Then the "briefing" screen is shown
    And the briefing asks for the route
    And the briefing asks for the workout
    And the focus is on "Free ride"
    When I press Back
    Then the "main" screen is shown
    And 0 rides were requested

  Scenario: With the keyboard alone a route and a workout are chosen and the ride starts with them
    Given the athlete profile on this device holds an FTP of 250 W and a weight of 72 kg
    Given the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Start ride"
    And I move the focus to "Short loop"
    And I press Enter
    Then the briefing shows the route "Short loop"
    And the focus is on "No workout"
    When I move the focus to "Sweet Spot 3×12"
    And I press Enter
    Then the briefing shows the workout "Sweet Spot 3×12"
    And the focus is on "Start"
    When I press Enter
    Then 1 ride was requested
    And the latest ride request names the route "short-loop"
    And the latest ride request carries the workout "Sweet Spot 3×12"
    And the latest ride request names no planned entry
    And the latest ride request has a step of 225 W

  Scenario: Enter, Enter starts the usual ride
    Given the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Start ride"
    And I move the focus to "Short loop"
    And I press Enter
    And I move the focus to "No workout"
    And I press Enter
    And I press Enter
    And I press Back
    Then the "main" screen is shown
    When I move the focus to "Start ride"
    And I press Enter
    Then the briefing does not ask for the route
    And the focus is on "Start"
    When I press Enter
    Then 2 rides were requested
    And the two ride requests ask for the same ride

  Scenario: A free ride without a workout starts with neither
    Given the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Start ride"
    And I press Enter
    And I press Enter
    And I press Enter
    Then 1 ride was requested
    And the latest ride request names no route
    And the latest ride request carries no workout

  Scenario: The next workout fixes the workout and the ride is matched with its plan
    Given the athlete profile on this device holds an FTP of 250 W and a weight of 72 kg
    Given intervals.icu plans "Sweet Spot 3x12" on "2026-11-04" with the steps:
      | step     | duration | power  |
      | warmup   | 10m      | 50-75% |
      | repeat   | 3x       |        |
      | -        | 12m      | 90%    |
      | -        | 4m       | 55%    |
      | cooldown | 5m       | 60-40% |
    And the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I move the focus to "Next workout: Sweet Spot 3x12, Today"
    And I press Enter
    Then the "briefing" screen is shown
    And the briefing shows the workout "Sweet Spot 3x12"
    And the briefing marks the workout as fixed
    And the briefing asks for the route
    And the briefing does not ask for the workout
    When I move the focus to "Short loop"
    And I press Enter
    And I press Enter
    Then 1 ride was requested
    And the latest ride request carries the workout "Sweet Spot 3x12"
    And the latest ride request names the planned entry of "intervals.icu"
    And the latest ride request has a step of 225 W

  Scenario: A fixed point can be changed
    Given the athlete profile on this device holds an FTP of 250 W and a weight of 72 kg
    Given intervals.icu plans "Sweet Spot 3x12" on "2026-11-04" with the steps:
      | step | duration | power |
      | -    | 12m      | 90%   |
    And the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I move the focus to "Next workout: Sweet Spot 3x12, Today"
    And I press Enter
    And I move the focus to "Change workout"
    And I press Enter
    Then the briefing asks for the workout
    When I move the focus to "No workout"
    And I press Enter
    Then the briefing shows the workout "No workout"

  Scenario: Go on a route fixes the route and asks for the workout
    Given the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Ride"
    And I press "Short loop"
    And I press "Go"
    Then the "briefing" screen is shown
    And the briefing shows the route "Short loop"
    And the briefing marks the route as fixed
    And the briefing asks for the workout
    And the briefing does not ask for the route

  Scenario: Ride again fixes the route
    Given the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Ride Demo course again"
    Then the briefing shows the route "Demo course"
    And the briefing marks the route as fixed
    And the briefing asks for the workout

  Scenario: The details of a library workout offer Ride
    Given the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Training"
    And I move the focus to "Sweet Spot 3×12"
    And I press Enter
    And I press "Ride Sweet Spot 3×12"
    Then the briefing shows the workout "Sweet Spot 3×12"
    And the briefing marks the workout as fixed
    And the briefing asks for the route

  Scenario: The preview draws the route profile above the workout chart
    Given the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Start ride"
    And I move the focus to "Short loop"
    And I press Enter
    And I move the focus to "Sweet Spot 3×12"
    And I press Enter
    Then the briefing draws the route profile above the workout chart

  Scenario: The summary gives duration, distance, TSS and the time per zone
    Given the athlete profile on this device holds an FTP of 250 W and a weight of 72 kg
    Given the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Start ride"
    And I move the focus to "Short loop"
    And I press Enter
    And I move the focus to "Sweet Spot 3×12"
    And I press Enter
    Then the briefing shows the numbers:
      | Duration | 1 h 3 min |
      | Distance | 18.0 km   |
      | TSS      | 69        |
    And the briefing shows the time per zone:
      | Z1 Active Recovery     | 16 min 30 s |
      | Z2 Endurance           | 10 min 30 s |
      | Z3 Tempo               | 36 min      |
      | Z4 Threshold           | –           |
      | Z5 VO2 Max             | –           |
      | Z6 Anaerobic Capacity  | –           |
      | Z7 Neuromuscular Power | –           |

  Scenario: Different lengths are noted
    Given the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Start ride"
    And I move the focus to "Short loop"
    And I press Enter
    And I move the focus to "Sweet Spot 3×12"
    And I press Enter
    Then the briefing says "Workout 63 min, route about 35 min: the picture then stands still and the workout goes on."

  Scenario: Without paired devices the briefing offers Pair right there
    Given the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Start ride"
    Then the briefing shows the trainer as "not connected"
    And the briefing shows the heart-rate as "not connected"
    When I move the focus to "Pair trainer"
    And I press Enter
    Then the "setup" screen is shown in a dialog over the "briefing" screen
    When I press Back
    Then the "briefing" screen is shown

  Scenario: A route that is not on this device blocks the start and says so
    Given the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Start ride"
    And I move the focus to "Not here yet"
    And I press Enter
    And I press Enter
    Then the briefing says "The route is not on this device yet"
    And the start button of the briefing is disabled

  Scenario: A workout in % FTP without an FTP is explained and not started
    Given the rider chose the athlete profile of "ridrs"
    Given intervals.icu plans "Sweet Spot 3x12" on "2026-11-04" with the steps:
      | step | duration | power |
      | -    | 12m      | 90%   |
    And the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I move the focus to "Next workout: Sweet Spot 3x12, Today"
    And I press Enter
    And I move the focus to "Free ride"
    And I press Enter
    And I press Enter
    Then the briefing says "your profile has no FTP yet"
    And 0 rides were requested

  Scenario: The briefing speaks German
    Given the rider speaks German
    And the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Fahrt starten"
    Then the briefing says "Vor der Fahrt"
    And the page offers a "Zurück" button

  Scenario: Paired devices are shown as ready
    Given the briefing fixture devices are installed
    And the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    When I press "Start ride"
    Then the briefing shows the trainer as "connected"
    And the briefing shows the heart-rate as "connected"
    And the page offers no "Pair trainer" button
