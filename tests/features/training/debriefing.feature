@training @ui
Feature: A finished ride is saved or deleted in its debriefing
  After Finish ride, the debriefing shows the ride before the main screen does. The rider closes it
  with Save or Delete. With intervals.icu connected, Save uploads the ride's FIT file as a done
  activity and closes the debriefing once intervals.icu has it; without an account, Save keeps the
  ride on this device. Delete removes the recording and its FIT file after a confirmation. Back
  only offers Save: no ride is thrown away or left undecided by accident.

  Here intervals.icu, the browser and the secret store are simulated.

  Background:
    Given the ridrs plugins "activity-session, recording-session, export-fit, ui-main-screen, ui-tile-ride-start, ui-activity-screen, ui-debriefing, planner-intervals-icu, ui-training-plan" together with the simulated intervals.icu
    And intervals.icu knows the athlete "Alex Rider" with an FTP of 250 W and a weight of 72 kg
    And the local time is "2026-11-04 08:00"

  Scenario: Finishing a ride opens its debriefing
    Given the secret store holds a token for intervals.icu
    And the host has started
    And the ridrs UI is shown
    When I press "Start ride"
    And I press "Finish ride"
    Then the "debriefing" screen is shown
    And the debriefing shows "Ride finished"
    And the debriefing shows "Save uploads the ride to intervals.icu as Alex Rider."
    And the debriefing offers "Save" and "Delete"
    And the focus is on "Save"

  Scenario: Save uploads the FIT file and closes the debriefing
    Given the secret store holds a token for intervals.icu
    And the host has started
    And the ridrs UI is shown
    And I press "Start ride"
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
    And I press "Finish ride"
    And the debriefing shows "Save uploads the ride to intervals.icu"
    When I press "Save"
    Then the debriefing shows "intervals.icu asks you to connect again."
    And the secret store holds no intervals.icu token
    When intervals.icu answers uploads with 201
    And I press "Reconnect intervals.icu"
    And the athlete approves the sign-in
    Then the sign-in asked for the scope "SETTINGS:READ,CALENDAR:READ,WELLNESS:READ,ACTIVITY:WRITE"
    When I press "Try again"
    Then intervals.icu received the ride's FIT file as an activity with the session as its external id
    And the "main" screen is shown

  Scenario: Without an account, Save keeps the ride on this device
    Given the host has started
    And the ridrs UI is shown
    And I press "Start ride"
    And I press "Finish ride"
    And the debriefing shows "Save keeps the ride on this device. Connect intervals.icu in Me to upload rides."
    When I press "Save"
    Then the "main" screen is shown
    And intervals.icu received no upload
    And the memory storage keeps the ride's recording and FIT file

  Scenario: Delete asks first, Keep ride goes back
    Given the host has started
    And the ridrs UI is shown
    And I press "Start ride"
    And I press "Finish ride"
    And the debriefing shows "Save keeps the ride on this device."
    When I press "Delete"
    Then the debriefing shows "Delete this ride? It cannot be brought back."
    When I press "Keep ride"
    Then the "debriefing" screen is shown
    And the debriefing offers "Save" and "Delete"

  Scenario: Delete removes the recording and its FIT file
    Given the secret store holds a token for intervals.icu
    And the host has started
    And the ridrs UI is shown
    And I press "Start ride"
    And I press "Finish ride"
    And the debriefing shows "Save uploads the ride to intervals.icu"
    And the ride's FIT file is written
    When I press "Delete"
    And I press "Delete ride"
    Then the "main" screen is shown
    And the memory storage holds no recording and no FIT file
    And intervals.icu received no upload
    And the page shows no "Ride saved"

  Scenario: Back offers Save and leaves nothing
    Given the host has started
    And the ridrs UI is shown
    And I press "Start ride"
    And I press "Finish ride"
    And the debriefing shows "Save keeps the ride on this device."
    And I press "Delete"
    When I press Back
    Then the "debriefing" screen is shown
    And the focus is on "Save"
