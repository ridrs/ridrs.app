@ui
Feature: Changes in the app's areas take effect at once and are kept
  Like in a phone app, there is no Save: every change in an area takes effect when it is made and
  is still there after ridrs restarts. Each area keeps its own changes as a user settings
  document of its plugin (ADR 0059). Today shows a card of an area only while that area says so;
  the card can be hidden on Today and shown again in its area.

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-activity-screen, ui-landscape-demo, ui-devices, ui-area-ride, ui-area-training, ui-area-events, ui-area-me, ui-search, ui-settings, profile-local" together with a test device plugin "test-device"
    And the local time is "2026-11-04 08:00"
    And the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown

  Scenario: A favourite route is kept
    When I press "Ride"
    And I press "Favourite Demo course"
    Then the button "Favourite Demo course" is on
    When ridrs restarted
    And I reload the UI
    And I press "Ride"
    Then the button "Favourite Demo course" is on
    And the user settings hold the file "config/user/ui-area-ride/preview.json"

  Scenario: Two clicks from a route to the ride
    When I press "Ride"
    And I press "Demo course"
    And I press "Go"
    Then the "activity" screen is shown

  Scenario: A joined event becomes the next event on Today
    When I press "Events"
    And I press "Join Sunday Club Race"
    Then the button "Join Sunday Club Race" is on
    When I press "Today"
    Then the tile "ui-area-events/next-event" names "Sunday Club Race"

  Scenario: A card on Today is hidden there and shown again in its area
    Then the tile "ui-area-ride/ride-again" names "Ride again"
    When I press "Hide Ride again"
    Then the tile "ui-area-ride/ride-again" is mounted but hidden
    When I press "Ride"
    Then the button "Show Ride again on Today" is off
    When I press "Show Ride again on Today"
    And I press "Today"
    Then the tile "ui-area-ride/ride-again" names "Ride again"

  Scenario: A workout dragged onto a day is kept
    When I press "Training"
    And I drag the workout "Recovery Spin" onto "Friday"
    Then the calendar day "Friday" lists "Recovery Spin"
    When ridrs restarted
    And I reload the UI
    And I press "Training"
    Then the calendar day "Friday" lists "Recovery Spin"

  Scenario: A planned workout is moved to another day by dragging
    When I press "Training"
    And I drag the planned workout "VO2 Max 5×4" onto "Friday"
    Then the calendar day "Friday" lists "VO2 Max 5×4"
    And the calendar day "Thursday" lists no "VO2 Max 5×4"

  Scenario: A day that has passed takes no workout and its workouts stay
    When I press "Training"
    And I drag the workout "Recovery Spin" onto "Monday"
    Then the calendar day "Monday" lists no "Recovery Spin"
    And the planned workout "Sweet Spot 3×12" cannot be dragged

  Scenario: The calendar shows the days side by side with nothing to select
    When I press "Training"
    Then the calendar shows the week starting "2026-11-02"
    And the Training area has no button "Wednesday"
    And the Training area has no button "Later"
    And the Training area has no button "Undo"

  Scenario: The arrows page through the weeks
    When I press "Training"
    And I press "Next week"
    Then the calendar shows the week starting "2026-11-09"
    When I press "Previous week"
    And I press "Previous week"
    Then the calendar shows the week starting "2026-10-26"

  Scenario: The calendar of ridrs takes workouts in this week only
    When I press "Training"
    And I press "Next week"
    And I drag the workout "Recovery Spin" onto "Friday"
    Then the calendar day "Friday" lists no "Recovery Spin"

  Scenario: The large calendar is a page of its own
    When I press "Training"
    And I press "Open large calendar"
    Then the large calendar is shown
    And the calendar day "Thursday" lists "VO2 Max 5×4"
    And the Training area has no button "Open large calendar"
    When I press Back
    Then the Training area has the button "Open large calendar"

  Scenario: The FTP is changed in steps and kept
    When I press "Profile"
    And I press "Raise FTP"
    And I press "Raise FTP"
    Then the FTP reads "210 W"
    When ridrs restarted
    And I reload the UI
    And I press "Profile"
    Then the FTP reads "210 W"

  Scenario: A setting takes effect at once and is kept
    When I press "Settings"
    And I press "Imperial"
    Then the button "Imperial" is on
    And the button "Metric" is off
    When ridrs restarted
    And I reload the UI
    And I press "Settings"
    Then the button "Imperial" is on

  Scenario: One search finds routes, workouts and events
    When I press "Search"
    And I type "sun" into "Search"
    Then the search finds "Sunday Club Race"
    When I type "sweet" into "Search"
    Then the search finds "Sweet Spot 3×12"
    When I type "alp" into "Search"
    Then the search finds "Alpine Loop"
    When I press "Alpine Loop"
    Then the "ride" screen is shown
