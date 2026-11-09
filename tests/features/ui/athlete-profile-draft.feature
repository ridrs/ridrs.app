@ui @training @draft
Feature: The Me area saves the athlete profile of intervals.icu once
  A source behind an external API, like intervals.icu, costs a request for every change (ADR 0078).
  So the steppers for FTP and weight change a draft only, and one button "Save" sends it: one
  call that carries both values, and a request only for the value that changed. The button is
  enabled only while the draft differs from what the source holds. Back with an open draft does
  not throw it away and sends nothing: it moves the focus to "Save", next to "Discard". A refused
  save keeps the draft and says why. The profile of ridrs on this device is not remote and keeps
  its changes at once.

  Here intervals.icu, the browser and the secret store are simulated.

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-settings, ui-area-me, profile-local, planner-intervals-icu, ui-training-plan" together with the simulated intervals.icu
    And a test device plugin "test-device"
    And intervals.icu knows the athlete "Alex Rider" with an FTP of 250 W and a weight of 72 kg
    And the local time is "2026-11-04 08:00"
    And the secret store holds a token for intervals.icu
    And the host has started
    And the athlete profile of "intervals.icu" is in use
    And the main screen is 1400 px wide
    And the ridrs UI is shown
    And I press "Profile"
    And the FTP reads "250 W"
    And the simulated intervals.icu forgets the requests so far

  Scenario: Ten clicks and one save are one request
    When I press "Raise FTP" 10 times
    Then the FTP reads "300 W"
    And intervals.icu received 0 requests
    And the button "Save" is enabled
    When I press "Save"
    Then intervals.icu received 1 requests "PUT /api/v1/athlete/0/sport-settings/Ride"
    And intervals.icu received 1 requests
    And the FTP reads "300 W"
    And the button "Save" is disabled

  Scenario: A value changed and changed back is no change
    When I press "Raise FTP"
    And I press "Raise FTP"
    And I press "Lower FTP"
    And I press "Lower FTP"
    Then the FTP reads "250 W"
    And the button "Save" is disabled
    And the button "Discard" is disabled
    And intervals.icu received 0 requests

  Scenario: Saving FTP and weight together sends one request for each
    When I press "Raise FTP"
    And I press "Raise Weight"
    And I press "Save"
    Then intervals.icu received 1 requests "PUT /api/v1/athlete/0/wellness/*"
    And intervals.icu received 1 requests "PUT /api/v1/athlete/0/sport-settings/Ride"
    And intervals.icu received 2 requests
    And the FTP reads "255 W"
    And the weight reads "72.5 kg"

  Scenario: Only the value that changed is sent
    When I press "Raise Weight"
    And I press "Raise FTP"
    And I press "Lower FTP"
    And I press "Save"
    Then intervals.icu received 1 requests
    And intervals.icu received 1 requests "PUT /api/v1/athlete/0/wellness/*"

  Scenario: The draft is not shown to the next ride before it is saved
    When I press "Raise FTP"
    Then the latest athlete handed to the next ride is from "intervals.icu" with an FTP of 250 W and a weight of 72 kg
    When I press "Save"
    Then the latest athlete handed to the next ride is from "intervals.icu" with an FTP of 255 W and a weight of 72 kg

  Scenario: A refused save keeps the draft and says why
    Given intervals.icu cannot be reached for writes
    When I press "Raise Weight"
    And I press "Save"
    Then the page says "intervals.icu could not be reached: the value stays as it was."
    And the weight reads "72.5 kg"
    And the button "Save" is enabled
    When intervals.icu can be reached for writes
    And the simulated intervals.icu forgets the requests so far
    And I press "Save"
    Then intervals.icu received 1 requests "PUT /api/v1/athlete/0/wellness/*"
    And the button "Save" is disabled

  Scenario: Back with an open draft sends nothing and moves the focus to Save
    When I press "Raise Weight"
    And I press Back
    Then the "me" screen is shown
    And the focus is on "Save"
    And the weight reads "72.5 kg"
    And the button "Discard" is enabled
    And intervals.icu received 0 requests

  Scenario: Discard puts the loaded values back
    When I press "Raise Weight"
    And I press "Raise FTP"
    And I press "Discard"
    Then the weight reads "72.0 kg"
    And the FTP reads "250 W"
    And the button "Save" is disabled
    And intervals.icu received 0 requests
    When I press Back
    Then the "main" screen is shown

  Scenario: Back without a draft leaves as before
    When I press Back
    Then the "main" screen is shown
