@ui @training
Feature: A catalogue workout from the library to the calendar, in the zones of intervals.icu
  The vertical use case of phase 2 of structured workouts (structured-workouts.md, section 13),
  through the real plugins: intervals.icu is the source of the athlete profile and has its own
  power zones, eight of them with a sweet spot zone and names of their own. A ZWO workout of the
  built-in catalogue, "Sweet Spot 3×12", is drawn on its card in the zone colours of intervals.icu,
  not in those of Coggan. Enter opens its details in place of the Training area, the arrow keys
  step through its steps, and Back returns to the card. The workout is dragged into the calendar
  and the event created in intervals.icu has its content, as intervals.icu text in the description.
  Everything on the ride path works with the arrows, Enter and Back alone (ADR 0080).

  Here intervals.icu, the browser and the secret store are simulated. It is Wednesday 4 November
  2026.

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-settings, ui-area-training, library-ridrs, ui-area-me, profile-local, planner-intervals-icu, ui-training-plan, ui-workout-chart, ui-workout-details" together with the simulated intervals.icu
    And a test device plugin "test-device"
    And intervals.icu knows the athlete "Alex Rider" with an FTP of 250 W and a weight of 72 kg
    And intervals.icu keeps the Ride zones:
      | field            | values                                                                          |
      | power_zones      | 55, 75, 87, 94, 105, 120, 150, 999                                              |
      | power_zone_names | Recovery, Endurance, Tempo, Sweet Spot, Threshold, VO2 Max, Anaerobic, Neuromuscular |
    And the local time is "2026-11-04 08:00"
    And the secret store holds a token for intervals.icu
    And the host has started
    And the athlete profile of "intervals.icu" is in use
    And the main screen is 1400 px wide
    And the ridrs UI is shown

  Scenario: The card is drawn in the zones of intervals.icu, not in Coggan's
    When I press "Training"
    Then the steps "2.1" of the mini chart of "Sweet Spot 3×12" are drawn in zone 4 of 8 zones

  Scenario: Enter opens the details, the arrows step through the steps and Back returns to the card
    When I press "Training"
    And I move the focus to "Sweet Spot 3×12"
    And I press Enter
    Then the details of the workout show the name "Sweet Spot 3×12"
    And the details of the workout show "by ridrs · CC-BY-SA-4.0"
    And the details of the workout show the time per zone:
      | Z1 Recovery        | 16 min 30 s |
      | Z2 Endurance       | 10 min 30 s |
      | Z3 Tempo           | –           |
      | Z4 Sweet Spot      | 36 min      |
      | Z5 Threshold       | –           |
      | Z6 VO2 Max         | –           |
      | Z7 Anaerobic       | –           |
      | Z8 Neuromuscular   | –           |
    And the steps "2.1" of the workout chart in the details are drawn in zone 4 of 8 zones
    When I move the focus to the first step of the details of the workout
    Then the focused step of the details of the workout is "Warm-up"
    When I press the arrow key "Down"
    Then the focused step of the details of the workout is "Interval"
    And the selected step of the details of the workout is "Interval"
    And the workout chart in the details has the step "2.1" selected
    When I press Back
    Then no details of a workout are shown
    And the focus is on "Sweet Spot 3×12"

  Scenario: The workout is dragged into the calendar and intervals.icu gets its content
    When I press "Training"
    And I drag the workout "Sweet Spot 3×12" onto "Thursday"
    Then intervals.icu received "POST /api/v1/athlete/0/events" with the body:
      | category         | WORKOUT             |
      | start_date_local | 2026-11-05T00:00:00 |
      | type             | VirtualRide         |
      | name             | Sweet Spot 3×12     |
    And the event created in intervals.icu has the description:
      """
      Three blocks of 12 minutes at 90 % FTP with 4 minutes easy between them.

      - 10m ramp 50-75% intensity=warmup

      3x
      - 12m 90% intensity=interval
      - 4m 55% intensity=recovery

      - 5m ramp 65-45% intensity=cooldown
      """

  Scenario: The planned entry opens the same details with Enter and Back returns to it
    When I press "Training"
    And I drag the workout "Sweet Spot 3×12" onto "Thursday"
    Then the calendar day "Thursday" shows a micro chart for "Sweet Spot 3×12"
    When I move the focus to "Sweet Spot 3×12"
    And I press Enter
    Then the details of the workout show the name "Sweet Spot 3×12"
    And the details of the workout show "Planned for Thu 5 Nov"
    And the details of the workout show "by ridrs · CC-BY-SA-4.0"
    When I press Back
    Then no details of a workout are shown
    And the focus is on the planned workout "Sweet Spot 3×12"
