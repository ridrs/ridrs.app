@ui
Feature: Changes in the app's areas take effect at once and are kept
  Like in a phone app, there is no Save: every change in an area takes effect when it is made and
  is still there after ridrs restarts. Each area keeps its own changes as a user settings
  document of its plugin (ADR 0059). Today shows a card of an area only while that area says so;
  the card can be hidden on Today and shown again in its area.

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-activity-screen, ui-landscape-demo, ui-devices, ui-area-ride, ui-area-training, ui-area-events, ui-area-me, ui-search, ui-settings" together with a test device plugin "test-device"
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

  Scenario: A rest day added to the calendar is kept, and can be undone
    When I press "Training"
    And I press "Wednesday"
    And I press "Add a rest day on Wednesday"
    Then the calendar day "Wednesday" lists "Rest day"
    When ridrs restarted
    And I reload the UI
    And I press "Training"
    Then the calendar day "Wednesday" lists "Rest day"
    When I press "Undo"
    Then the calendar day "Wednesday" lists no "Rest day"

  Scenario: A workout is scheduled from the library
    When I press "Training"
    And I press "Friday"
    And I press "Schedule Recovery Spin on Friday"
    Then the calendar day "Friday" lists "Recovery Spin"

  Scenario: The FTP is changed in steps and kept
    When I press "Me"
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
