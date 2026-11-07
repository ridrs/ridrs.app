@training @ui
Feature: Connecting intervals.icu
  The rider connects their intervals.icu account from the main screen or the Me area (ADR 0048). ridrs opens
  intervals.icu in the system browser and receives the answer on 127.0.0.1. As a public client
  with PKCE, it sends no client secret, only the verifier of its challenge. The token goes to the
  secret store and nowhere else, so a restart stays connected. Disconnecting, in the Me area, revokes
  it.

  Here intervals.icu, the browser and the secret store are simulated; the simulated sign-in listens on
  port 53682.

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-tile-ride-start, ui-area-me, planner-intervals-icu, ui-training-plan" together with the simulated intervals.icu
    And intervals.icu knows the athlete "Alex Rider" with an FTP of 250 W and a weight of 72 kg
    And the local time is "2026-11-04 08:00"

  Scenario: Without an account the main screen offers to connect
    Given the host has started
    And the ridrs UI is shown
    Then the training tile offers a "Connect intervals.icu" button
    And no request reached intervals.icu

  Scenario: Connecting signs in with PKCE as a public client
    Given the host has started
    And the ridrs UI is shown
    When I press "Connect intervals.icu"
    Then the browser was opened at "https://intervals.icu/oauth/authorize" with:
      | client_id             | 1697                                  |
      | scope                 | SETTINGS:READ,CALENDAR:READ,ACTIVITY:WRITE |
      | code_challenge_method | S256                                  |
      | redirect_uri          | http://127.0.0.1:53682/oauth/callback |
    And the sign-in asked for a code challenge and a state
    And the training tile shows "Connecting to intervals.icu…"
    When the athlete approves the sign-in
    Then the code was exchanged with the verifier of the challenge and without a client secret
    And the secret store holds the intervals.icu token
    And the training tile shows "Connected as Alex Rider"

  Scenario: Declining the sign-in leaves the rider disconnected
    Given the host has started
    And the ridrs UI is shown
    When I press "Connect intervals.icu"
    And the athlete declines the sign-in
    Then the training tile shows "Sign-in cancelled"
    And the training tile offers a "Connect intervals.icu" button
    And the secret store holds no intervals.icu token

  Scenario: An answer with a different state is rejected
    Given the host has started
    And the ridrs UI is shown
    When I press "Connect intervals.icu"
    And the browser returns a code with a different state
    Then no code was exchanged
    And the training tile shows "Sign-in failed"
    And the secret store holds no intervals.icu token

  Scenario: The token stays secret
    Given the host has started
    And the ridrs UI is shown
    When I press "Connect intervals.icu"
    And the athlete approves the sign-in
    Then no event on the bus contains the intervals.icu token
    And no app file contains the intervals.icu token

  Scenario: A stored token connects at start without a sign-in
    Given the secret store holds a token for intervals.icu
    When the host has started
    And the ridrs UI is shown
    Then the training tile shows "Connected as Alex Rider"
    And the browser was not opened

  Scenario: A rejected token asks the rider to reconnect
    Given the secret store holds a token for intervals.icu
    And intervals.icu rejects the token
    When the host has started
    And the ridrs UI is shown
    Then the training tile offers a "Reconnect intervals.icu" button
    And the secret store holds no intervals.icu token

  Scenario: The Me area shows the account
    Given the secret store holds a token for intervals.icu
    And the host has started
    And the ridrs UI is shown
    When I press "Profile"
    Then the "me" screen is shown
    And the Me area shows "intervals.icu · Connected as Alex Rider"
    And the Me area offers a "Disconnect intervals.icu" button

  Scenario: The Me area offers to connect
    Given the host has started
    And the ridrs UI is shown
    When I press "Profile"
    Then the Me area shows "intervals.icu · Not connected"
    When I press "Connect intervals.icu"
    Then the Me area shows "Connecting to intervals.icu…"
    When the athlete approves the sign-in
    Then the Me area shows "Connected as Alex Rider"

  Scenario: Disconnecting in the Me area revokes the token
    Given the secret store holds a token for intervals.icu
    And the host has started
    And the ridrs UI is shown
    When I press "Profile"
    And I press "Disconnect intervals.icu"
    Then intervals.icu received "DELETE /api/v1/disconnect-app" with the token
    And the secret store holds no intervals.icu token
    And the Me area offers a "Connect intervals.icu" button

  Scenario: The workout details offer no Disconnect
    Given the secret store holds a token for intervals.icu
    And the host has started
    And the ridrs UI is shown
    When I open the next workout
    Then the page offers a "Refresh" button
    And the page offers no "Disconnect intervals.icu" button
