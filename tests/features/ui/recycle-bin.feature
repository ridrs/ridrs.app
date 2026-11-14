@ui @training
Feature: The recycle bin at the bottom of the menu
  The bin is the last entry of the main menu (ADR 0096). A planned workout or a ride done dragged
  onto it is not deleted: it goes into the bin and is hidden everywhere, and the bin counts it. The
  bin's page lists what it holds: Restore gives an item back, Delete permanently deletes it at
  every provider that has it, after asking, and Empty bin does so for all. The bin is kept across a
  restart.

  Here intervals.icu, the browser and the secret store are simulated. It is Wednesday 4 November
  2026.

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-settings, ui-area-training, library-ridrs, ui-area-me, profile-local, planner-intervals-icu, ui-training-plan, ui-recycle-bin" together with the simulated intervals.icu
    And a test device plugin "test-device"
    And intervals.icu knows the athlete "Alex Rider" with an FTP of 250 W and a weight of 72 kg
    And intervals.icu plans:
      | date       | type | name         | duration | load |
      | 2026-11-05 | Ride | Threshold 20 | 1h       | 80   |
      | 2026-11-06 | Ride | Easy 60      | 1h       | 40   |
    And intervals.icu has done:
      | date       | name         | duration | load |
      | 2026-11-02 | Monday Spin  | 1h       | 50   |
    And the local time is "2026-11-04 08:00"
    And the main screen is 1400 px wide
    And the secret store holds a token for intervals.icu
    And the host has started
    And the ridrs UI is shown

  Scenario: The bin is the last entry of the menu and is empty at first
    Then the last entry of the menu is "Bin"
    And the bin in the menu counts 0 items
    When I press "Bin"
    Then the "trash" screen is shown
    And the bin is empty
    And the button "Empty bin" is disabled

  Scenario: A planned workout dropped into the bin is hidden, not deleted
    Given the simulated intervals.icu forgets the requests so far
    When I press "Training"
    And I drag the planned workout "Threshold 20" into the bin
    Then the calendar day "Thursday" lists no "Threshold 20"
    And intervals.icu received 0 requests "DELETE /api/v1/athlete/0/events/*"
    And the bin in the menu counts 1 item
    When I press "Bin"
    Then the bin lists "Threshold 20"

  Scenario: Restore gives the workout back
    When I press "Training"
    And I drag the planned workout "Threshold 20" into the bin
    And I press "Bin"
    And I press "Restore Threshold 20"
    Then the bin is empty
    When I press "Training"
    Then the calendar day "Thursday" lists "Threshold 20"

  Scenario: Delete permanently asks first, then deletes at intervals.icu
    When I press "Training"
    And I drag the planned workout "Threshold 20" into the bin
    And I press "Bin"
    And the simulated intervals.icu forgets the requests so far
    And I press "Delete permanently: Threshold 20"
    Then the bin asks "Delete “Threshold 20” from intervals.icu? This cannot be undone."
    When I press "Cancel"
    Then the bin lists "Threshold 20"
    And intervals.icu received 0 requests "DELETE /api/v1/athlete/0/events/*"
    When I delete "Threshold 20" permanently from the bin
    Then intervals.icu received 1 requests "DELETE /api/v1/athlete/0/events/*"
    And the bin is empty

  Scenario: A refused deletion stays in the bin and says why
    When I press "Training"
    And I drag the planned workout "Threshold 20" into the bin
    And intervals.icu cannot be reached for writes
    And I press "Bin"
    And I delete "Threshold 20" permanently from the bin
    Then the bin lists "Threshold 20"
    And the page says "intervals.icu could not be reached: nothing was removed."

  Scenario: Empty bin deletes everything in it
    When I press "Training"
    And I drag the planned workout "Threshold 20" into the bin
    And I drag the planned workout "Easy 60" into the bin
    Then the bin in the menu counts 2 items
    When I press "Bin"
    Then the bin lists "Easy 60"
    When the simulated intervals.icu forgets the requests so far
    And I press "Empty bin"
    And I press "Delete permanently"
    Then intervals.icu received 2 requests "DELETE /api/v1/athlete/0/events/*"
    And the bin is empty
    And the bin in the menu counts 0 items

  Scenario: The bin is kept across a restart
    When I press "Training"
    And I drag the planned workout "Threshold 20" into the bin
    And ridrs restarted
    And I reload the UI
    Then the bin in the menu counts 1 item
    When I press "Training"
    Then the calendar day "Thursday" lists no "Threshold 20"

  Scenario: The bin speaks German
    When I press "Settings"
    And I press "Deutsch"
    And I press "Schließen"
    And I press "Papierkorb"
    Then the page says "Der Papierkorb ist leer."
