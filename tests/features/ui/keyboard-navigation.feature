@ui
Feature: Using the UI with arrow keys, Enter and Back
  Every screen works with the arrow keys, Enter and Back alone (AGENTS.md rule 12), so a rider
  on the bike can use a keyboard, a remote or a controller instead of the mouse. The shell does
  this for every screen: the arrow keys move the focus through the screen's controls in reading
  order, Enter activates the focused one, and Back (Escape, Backspace, or the platform's back
  button) goes to the screen, which decides what it means. In a text field the caret keeps the
  left and right arrows and Backspace deletes. The arrows never start over at the top by surprise:
  when the focused control disappears, the next arrow goes on from its place, and a control never
  turns into another one under the focus.

  A headless DOM has no default actions, so "I press Enter" clicks the focused button the way a
  browser does; the step checks that the focus is on a real button.

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-tile-ride-start, ui-activity-screen, ui-devices" together with a test device plugin "test-device"
    And the host has started
    And the ridrs UI is shown

  Scenario: The first arrow press focuses the first control of the screen
    When I press the arrow key "Down"
    Then the focus is on "Devices"

  Scenario: Down and Right move the focus forward, Up and Left back
    When I press the arrow key "Down"
    And I press the arrow key "Down"
    Then the focus is on "Start ride"
    When I press the arrow key "Left"
    Then the focus is on "Devices"
    When I press the arrow key "Right"
    Then the focus is on "Start ride"
    When I press the arrow key "Up"
    Then the focus is on "Devices"

  Scenario: The focus stays at the ends of the screen
    When I press the arrow key "Down"
    And I press the arrow key "Up"
    Then the focus is on "Devices"

  Scenario: Enter activates the focused control
    When I press the arrow key "Down"
    And I press the arrow key "Down"
    And I press the arrow key "Down"
    Then the focus is on "Set up your devices"
    When I press Enter
    Then the "setup" screen is shown

  Scenario: Back in the device setup returns to the main screen
    Given I open the device setup from the main screen
    When I press Back
    Then the "main" screen is shown

  Scenario: Backspace is Back as well
    Given I open the device setup from the main screen
    When I press Backspace
    Then the "main" screen is shown

  Scenario: Back from a device's details returns to its row
    Given "test-device" reported its "heart-rate" "HRM-Pro 42" as "connected"
    And I open the device setup from the main screen
    And I open the "Heart Rate Monitor" in the device setup
    When I press Back
    Then the device details are closed
    And the focus is on the "Heart Rate Monitor" row

  Scenario: The device setup is used with the keyboard alone
    Given "test-device" reported its "heart-rate" "HRM-Pro 42" as "connected"
    And I move the focus to "All devices"
    And I press Enter
    When I press the arrow key "Down"
    Then the focus is on "Close"
    When I press the arrow key "Down"
    And I press the arrow key "Down"
    And I press the arrow key "Down"
    Then the focus is on the "Heart Rate Monitor" row
    When I press Enter
    Then the details are headed "Heart Rate Monitor", the card "HRM-Pro 42" with the status "Connected"
    And the focus is on "Back"

  Scenario: Back during a ride does not finish it, but offers Finish ride
    Given I press "Start ride"
    And the "activity" screen is shown
    When I press Back
    Then the "activity" screen is shown
    And the focus is on "Finish ride"

  Scenario: The main screen ignores Back
    When I press Back
    Then the "main" screen is shown

  Scenario: The arrows go on from where a control was when it disappears
    Given "test-device" reported its "heart-rate" "HRM-Pro 42" as "connected"
    And "test-device" found the "heart-rate" devices "HRM-Pro 42, Garmin HRM 3, Polar H10 A1B2"
    And I open the device setup from the main screen
    And I open the "Heart Rate Monitor" in the device setup
    And I move the focus to "Connect Polar H10 A1B2 with Bluetooth"
    When "test-device" found the "heart-rate" devices "HRM-Pro 42, Garmin HRM 3"
    And I press the arrow key "Down"
    Then the focus is on "Connect Garmin HRM 3 with Bluetooth"

  Scenario: Connect does not turn into Remove under the focus
    Given "test-device" reported its "heart-rate" "HRM-Pro 42" as "disconnected"
    And I open the device setup from the main screen
    And I open the "Heart Rate Monitor" in the device setup
    And I move the focus to "Connect with Bluetooth"
    When I press Enter
    And "test-device" reports its "heart-rate" "HRM-Pro 42" as "connecting"
    Then nothing has the focus
    When I press the arrow key "Down"
    Then the focus is on "Remove"
