@phase-3 @fake-timers
Feature: Activity session
  A ride is a session that is requested to start and finish through events.
  The activity plugin is headless and knows nothing about any UI.

  Background:
    Given the host clock shows "10:00:00.000"
    And the ridrs plugin "activity-session" together with a probe plugin "test-ui"
    And the host has started

  Scenario: Without a ride the activity is idle
    Then the latest "activity.state-changed" event has the state "idle"

  Scenario: Starting a ride
    When "test-ui" publishes "activity.start-requested"
    Then the latest "activity.state-changed" event has the state "running"
    And it was started at "10:00:00.000"
    And it carries a session id

  Scenario: Finishing a ride
    Given "test-ui" published "activity.start-requested"
    And the host clock shows "10:30:00.000"
    When "test-ui" publishes "activity.finish-requested"
    Then the latest "activity.state-changed" event has the state "finished"
    And it was started at "10:00:00.000"
    And it ended at "10:30:00.000"
    And it carries the same session id as the "running" event

  Scenario: A new ride after a finished one gets a new session
    Given "test-ui" published "activity.start-requested"
    And "test-ui" published "activity.finish-requested"
    When "test-ui" publishes "activity.start-requested"
    Then the latest "activity.state-changed" event has the state "running"
    And its session id differs from the one of the finished ride

  Scenario: Starting a ride that is already running changes nothing
    Given "test-ui" published "activity.start-requested"
    When "test-ui" publishes "activity.start-requested"
    Then the host reported an "invalid-transition" problem for plugin "activity-session"
    And exactly one "activity.state-changed" event with the state "running" was published

  Scenario Outline: Finishing without a running ride changes nothing (<situation>)
    Given the ride is <situation>
    When "test-ui" publishes "activity.finish-requested"
    Then the host reported an "invalid-transition" problem for plugin "activity-session"
    And the latest "activity.state-changed" event has the state "<state>"

    Examples:
      | situation | state    |
      | idle      | idle     |
      | finished  | finished |

  Scenario: Starting a ride does not need a trainer
    When "test-ui" publishes "activity.start-requested"
    Then the latest "activity.state-changed" event has the state "running"
    And the host reported no problems
