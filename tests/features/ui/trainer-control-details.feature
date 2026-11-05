@phase-8 @devices @ui
Feature: The trainer's control state in its details
  The details of a connected trainer say in one short line whether ridrs controls it: the mode
  it drives the trainer in, or why it does not. Facts only, as the trainer's device plugin tells.

  Background:
    Given the ridrs plugins "activity-session, device-registry, ui-main-screen, ui-activity-screen, ui-devices" together with a test device plugin "test-device"
    And the host has started
    And the ridrs UI is shown
    And "test-device" reported its "trainer" "KICKR CORE 1234" as "connected"

  Scenario Outline: The details name the control: <control>, <mode>
    Given "test-device" reported the control "<control>" of its trainer in the mode "<mode>"
    And I open the device indicator
    When I open the "Smart Trainer" in the device setup
    Then the details show the fact "Control" "<shown>"

    Examples:
      | control     | mode       | shown         |
      | granted     | simulation | simulation    |
      | granted     | erg        | ERG 150 W     |
      | unsupported | none       | not supported |
      | refused     | none       | refused       |
      | lost        | none       | lost          |

  Scenario: Without a control state the details show no control line
    Given I open the device indicator
    When I open the "Smart Trainer" in the device setup
    Then the details show no fact "Control"
