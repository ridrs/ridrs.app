@phase-3 @fake-timers
Feature: The rider pauses and resumes a ride
  A paused ride stands still while time goes on (ADR 0056). It keeps its session; it can be
  resumed or finished.

  Background:
    Given the host clock shows "10:00:00.000"
    And the ridrs plugin "activity-session" together with a probe plugin "test-ui"
    And the host has started
    And "test-ui" published "activity.start-requested"

  Scenario: Pausing a running ride
    Given the host clock shows "10:10:00.000"
    When "test-ui" publishes "activity.pause-requested"
    Then the latest "activity.state-changed" event has the state "paused"
    And it was paused at "10:10:00.000" by the rider
    And it carries the same session id as the "running" event

  Scenario: Resuming a paused ride
    Given "test-ui" published "activity.pause-requested"
    And the host clock shows "10:12:00.000"
    When "test-ui" publishes "activity.resume-requested"
    Then the latest "activity.state-changed" event has the state "running"
    And it was started at "10:00:00.000"
    And it was resumed at "10:12:00.000"
    And it carries the same session id as the "paused" event

  Scenario: A paused ride can be finished
    Given "test-ui" published "activity.pause-requested"
    When "test-ui" publishes "activity.finish-requested"
    Then the latest "activity.state-changed" event has the state "finished"

  Scenario: An interruption pauses the ride
    When "test-ui" publishes "activity.interrupted"
    Then the latest "activity.state-changed" event has the state "paused"
    And it was paused because the ride was interrupted

  Scenario Outline: Requests that do not fit the state change nothing (<request> while <state>)
    Given the ride is <state>
    When "test-ui" publishes "<request>"
    Then the host reported an "invalid-transition" problem for plugin "activity-session"
    And the latest "activity.state-changed" event has the state "<state>"

    Examples:
      | state    | request                   |
      | running  | activity.resume-requested |
      | paused   | activity.pause-requested  |

  Scenario: A finished ride cannot be paused
    Given "test-ui" published "activity.finish-requested"
    When "test-ui" publishes "activity.pause-requested"
    Then the host reported an "invalid-transition" problem for plugin "activity-session"
    And the latest "activity.state-changed" event has the state "finished"
