@training @ui
Feature: The activity menu over a ride and saving or deleting a finished ride
  Menu on the activity screen pauses a running ride and opens the activity menu in a dialog over the
  activity screen (ADR 0108). From there the rider goes back to the ride with Continue ride or Back
  (a ride that ran before goes on, a paused one stays paused), opens Devices or Settings in the same
  dialog, or presses Finish ride to end the ride. Only once the ride is ended does the dialog show
  Ride finished with a large Save button and a small Delete button. With intervals.icu connected,
  Save uploads the ride's FIT file as a done activity and closes the dialog once intervals.icu has
  it; without an account, Save keeps the ride on this device. Delete asks "Are you sure?" with Yes
  and No before removing the recording and its FIT file. Once the ride is ended, Back only offers
  Save: no ride is thrown away or left undecided by accident.

  Here intervals.icu, the browser and the secret store are simulated.

  Background:
    Given the ridrs plugins "activity-session, recording-session, export-fit, ui-main-screen, ui-tile-ride-start, ui-activity-screen, ui-debriefing, ui-settings, ui-devices, planner-intervals-icu, ui-training-plan" together with the simulated intervals.icu
    And intervals.icu knows the athlete "Alex Rider" with an FTP of 250 W and a weight of 72 kg
    And the local time is "2026-11-04 08:00"

  Scenario: Menu pauses the ride and opens the activity menu without Save or Delete yet
    Given the secret store holds a token for intervals.icu
    And the host has started
    And the ridrs UI is shown
    When I press "Start ride"
    And I press "Menu"
    Then the "debriefing" screen is shown
    And the "debriefing" screen is shown in a dialog over the "activity" screen
    And the latest "activity.state-changed" event has the state "paused"
    And the debriefing shows "Ride menu"
    And the debriefing offers "Continue ride" and "Finish ride"
    And the debriefing offers neither "Save" nor "Delete"
    And the focus is on "Continue ride"

  Scenario: Continue ride goes back to the ride
    Given the host has started
    And the ridrs UI is shown
    And I press "Start ride"
    And I press "Menu"
    And the debriefing shows "Ride menu"
    When I press "Continue ride"
    Then no dialog is shown
    And the "activity" screen is shown
    And the latest "activity.state-changed" event has the state "running"
    And the focus is on "Menu"

  Scenario: Back goes back to the ride while it is not ended
    Given the host has started
    And the ridrs UI is shown
    And I press "Start ride"
    And I press "Menu"
    And the debriefing shows "Ride menu"
    When I press Back
    Then no dialog is shown
    And the "activity" screen is shown
    And the latest "activity.state-changed" event has the state "running"

  Scenario: A paused ride stays paused when the rider goes back to it
    Given the host has started
    And the ridrs UI is shown
    And I press "Start ride"
    And I press "Pause"
    And I press "Menu"
    And the debriefing shows "Ride menu"
    When I press "Continue ride"
    Then no dialog is shown
    And the latest "activity.state-changed" event has the state "paused"
    And the page offers a "Resume" button

  Scenario: The settings open from the activity menu and lead back to it
    Given the host has started
    And the ridrs UI is shown
    And I press "Start ride"
    And I press "Menu"
    And the debriefing shows "Ride menu"
    When I press "Settings"
    Then the "settings" screen is shown in a dialog over the "activity" screen
    When I press Back
    Then the "debriefing" screen is shown in a dialog over the "activity" screen
    And the debriefing shows "Ride menu"
    And the latest "activity.state-changed" event has the state "paused"

  Scenario: The devices open from the activity menu and lead back to it
    Given the host has started
    And the ridrs UI is shown
    And I press "Start ride"
    And I press "Menu"
    And the debriefing shows "Ride menu"
    When I press "Devices"
    Then the "setup" screen is shown in a dialog over the "activity" screen
    When I press Back
    Then the "debriefing" screen is shown in a dialog over the "activity" screen
    And the debriefing shows "Ride menu"
    And the latest "activity.state-changed" event has the state "paused"

  Scenario: Finish ride in the menu ends the ride and shows a large Save button and a small Delete button
    Given the secret store holds a token for intervals.icu
    And the host has started
    And the ridrs UI is shown
    When I press "Start ride"
    And I press "Menu"
    And I press "Finish ride"
    Then the latest "activity.state-changed" event has the state "finished"
    And the debriefing shows "Ride finished"
    And the debriefing shows "Save uploads the ride to intervals.icu as Alex Rider."
    And the debriefing offers "Save" and "Delete"
    And the debriefing offers no "Continue ride"
    And the "Save" button in the debriefing is emphasized over the small "Delete" button
    And the focus is on "Save"

  Scenario: Save uploads the FIT file and closes the debriefing
    Given the secret store holds a token for intervals.icu
    And the host has started
    And the ridrs UI is shown
    And I press "Start ride"
    And I press "Menu"
    And I press "Finish ride"
    And the debriefing shows "Save uploads the ride to intervals.icu"
    When I press "Save"
    Then intervals.icu received the ride's FIT file as an activity with the session as its external id
    And the "main" screen is shown
    And the memory storage keeps the ride's recording and FIT file

  Scenario: Save works at once and uploads as soon as the FIT file is there
    Given the secret store holds a token for intervals.icu
    And the host has started
    And the ridrs UI is shown
    And the app files are written slowly from now on
    And I press "Start ride"
    And I press "Menu"
    And I press "Finish ride"
    Then the debriefing shows "Save uploads the ride to intervals.icu as Alex Rider."
    And the debriefing offers "Save"
    When I press "Save"
    Then the debriefing shows "Uploading to intervals.icu…"
    And intervals.icu received no upload
    When the app files are written again
    Then intervals.icu received the ride's FIT file as an activity with the session as its external id
    And the "main" screen is shown

  Scenario: An upload that does not get through can be tried again
    Given the secret store holds a token for intervals.icu
    And the host has started
    And the ridrs UI is shown
    And intervals.icu cannot be reached for uploads
    And I press "Start ride"
    And I press "Menu"
    And I press "Finish ride"
    And the debriefing shows "Save uploads the ride to intervals.icu"
    When I press "Save"
    Then the debriefing shows "intervals.icu could not be reached. The ride is kept on this device."
    And the "debriefing" screen is shown
    And the debriefing offers "Try again", "Save without upload" and "Delete"
    When intervals.icu can be reached for uploads again
    And I press "Try again"
    Then intervals.icu received the ride's FIT file as an activity with the session as its external id
    And the "main" screen is shown

  Scenario: A rejected token asks to connect again, then the upload goes through
    Given the secret store holds a token for intervals.icu
    And the host has started
    And the ridrs UI is shown
    And intervals.icu answers uploads with 403
    And I press "Start ride"
    And I press "Menu"
    And I press "Finish ride"
    And the debriefing shows "Save uploads the ride to intervals.icu"
    When I press "Save"
    Then the debriefing shows "intervals.icu asks you to connect again."
    And the secret store holds no intervals.icu token
    When intervals.icu answers uploads with 201
    And I press "Reconnect intervals.icu"
    And the athlete approves the sign-in
    Then the sign-in asked for the scope "SETTINGS:WRITE,CALENDAR:WRITE,WELLNESS:WRITE,LIBRARY:READ,ACTIVITY:WRITE"
    When I press "Try again"
    Then intervals.icu received the ride's FIT file as an activity with the session as its external id
    And the "main" screen is shown

  Scenario: Without an account, Save keeps the ride on this device
    Given the host has started
    And the ridrs UI is shown
    And I press "Start ride"
    And I press "Menu"
    And I press "Finish ride"
    And the debriefing shows "Save keeps the ride on this device. Connect intervals.icu in Me to upload rides."
    When I press "Save"
    Then the "main" screen is shown
    And intervals.icu received no upload
    And the memory storage keeps the ride's recording and FIT file

  Scenario: Delete asks "Are you sure?" with Yes and No, and No goes back
    Given the host has started
    And the ridrs UI is shown
    And I press "Start ride"
    And I press "Menu"
    And I press "Finish ride"
    And the debriefing shows "Save keeps the ride on this device."
    When I press "Delete"
    Then the debriefing shows "Are you sure?"
    And the debriefing offers "Yes" and "No"
    And the focus is on "No"
    When I press "No"
    Then the "debriefing" screen is shown
    And the debriefing offers "Save" and "Delete"
    And the focus is on "Save"

  Scenario: Delete removes the recording and its FIT file when confirmed with Yes
    Given the secret store holds a token for intervals.icu
    And the host has started
    And the ridrs UI is shown
    And I press "Start ride"
    And I press "Menu"
    And I press "Finish ride"
    And the debriefing shows "Save uploads the ride to intervals.icu"
    When I press "Delete"
    And I press "Yes"
    Then the "main" screen is shown
    And the memory storage holds no recording and no FIT file
    And intervals.icu received no upload
    And the page shows no "Ride saved"

  Scenario: Back offers Save and leaves nothing
    Given the host has started
    And the ridrs UI is shown
    And I press "Start ride"
    And I press "Menu"
    And I press "Finish ride"
    And the debriefing shows "Save keeps the ride on this device."
    And I press "Delete"
    When I press Back
    Then the "debriefing" screen is shown
    And the focus is on "Save"

  Scenario: Back keeps an ended ride in its debriefing
    Given the secret store holds a token for intervals.icu
    And the host has started
    And the ridrs UI is shown
    And intervals.icu cannot be reached for uploads
    And I press "Start ride"
    And I press "Menu"
    And I press "Finish ride"
    And the debriefing shows "Save uploads the ride to intervals.icu"
    And I press "Save"
    And the debriefing shows "intervals.icu could not be reached. The ride is kept on this device."
    When I press Back
    Then the "debriefing" screen is shown in a dialog over the "activity" screen
    And the latest "activity.state-changed" event has the state "finished"
    And the focus is on "Try again"
