@training @ui
Feature: Connecting intervals.icu
  The rider connects their intervals.icu account from the main screen (ADR 0048). ridrs opens
  intervals.icu in the system browser and receives the answer on 127.0.0.1. As a public client
  with PKCE, it sends no client secret, only the verifier of its challenge. The token goes to the
  OS keychain and nowhere else, so a restart stays connected. Disconnecting revokes it.

  intervals.icu accepts only the exact redirect URI registered for the app, port included, so ridrs
  always listens on port 47261. Here intervals.icu, the browser and the keychain are simulated.

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, planner-intervals-icu, ui-training-plan" together with the simulated intervals.icu
    And intervals.icu knows the athlete "Alex Rider" with an FTP of 250 W and a weight of 72 kg
    And the local time is "2026-11-04 08:00"

  Scenario: Without an account the main screen offers to connect
    Given the host has started
    And the ridrs UI is shown
    Then the main panel offers a "Connect intervals.icu" button
    And no request reached intervals.icu

  Scenario: Connecting signs in with PKCE as a public client
    Given the host has started
    And the ridrs UI is shown
    When I press "Connect intervals.icu"
    Then the browser was opened at "https://intervals.icu/oauth/authorize" with:
      | client_id             | 1697                                  |
      | scope                 | SETTINGS:READ,CALENDAR:READ           |
      | code_challenge_method | S256                                  |
      | redirect_uri          | http://127.0.0.1:47261/oauth/callback |
    And the sign-in asked for a code challenge and a state
    And the main panel shows "Connecting to intervals.icu…"
    When the athlete approves the sign-in
    Then the code was exchanged with the verifier of the challenge and without a client secret
    And the keychain holds the intervals.icu token
    And the main panel shows "Connected as Alex Rider"

  Scenario: Declining the sign-in leaves the rider disconnected
    Given the host has started
    And the ridrs UI is shown
    When I press "Connect intervals.icu"
    And the athlete declines the sign-in
    Then the main panel shows "Sign-in cancelled"
    And the main panel offers a "Connect intervals.icu" button
    And the keychain holds no intervals.icu token

  Scenario: An answer with a different state is rejected
    Given the host has started
    And the ridrs UI is shown
    When I press "Connect intervals.icu"
    And the browser returns a code with a different state
    Then no code was exchanged
    And the main panel shows "Sign-in failed"
    And the keychain holds no intervals.icu token

  Scenario: The token stays secret
    Given the host has started
    And the ridrs UI is shown
    When I press "Connect intervals.icu"
    And the athlete approves the sign-in
    Then no event on the bus contains the intervals.icu token
    And no app file contains the intervals.icu token

  Scenario: A stored token connects at start without a sign-in
    Given the keychain holds a token for intervals.icu
    When the host has started
    And the ridrs UI is shown
    Then the main panel shows "Connected as Alex Rider"
    And the browser was not opened

  Scenario: A rejected token asks the rider to reconnect
    Given the keychain holds a token for intervals.icu
    And intervals.icu rejects the token
    When the host has started
    And the ridrs UI is shown
    Then the main panel offers a "Reconnect intervals.icu" button
    And the keychain holds no intervals.icu token

  Scenario: Disconnecting revokes the token
    Given the keychain holds a token for intervals.icu
    And the host has started
    And the ridrs UI is shown
    When I open the next workout
    And I press "Disconnect intervals.icu"
    Then intervals.icu received "DELETE /api/v1/disconnect-app" with the token
    And the keychain holds no intervals.icu token
    And the "main" screen is shown
    And the main panel offers a "Connect intervals.icu" button
