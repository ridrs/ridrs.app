@devices @ui
Feature: The device indicator on the main screen
  The main screen shows one dot per kind of device. The trainer measures power too and is the
  only source of power so far, so the power box shows the trainer, the same way as in its own
  box: searching while the trainer is searched for. Clicking the indicator opens the device setup with one row per kind;
  Continue (or Done, once everything is connected) leads back to the main screen.

  Background:
    Given the ridrs plugins "activity-session, device-registry, ui-main-screen, ui-activity-screen, ui-devices" together with a test device plugin "test-device"
    And the host has started
    And the ridrs UI is shown

  Scenario: Without devices the indicator invites the rider to set them up
    Then the device indicator says "Set up your devices"

  Scenario: The indicator shows one dot per kind
    When "test-device" reports its "trainer" "KICKR CORE 1234" as "connected"
    And "test-device" reports its "heart-rate" "HRM-Pro 42" as "searching"
    Then the device indicator shows:
      | device     | state     |
      | Trainer    | connected |
      | Power      | connected |
      | Heart rate | searching |

  Scenario: Clicking the indicator opens the device setup
    When I open the device indicator
    Then the "setup" screen is shown

  Scenario: The device setup shows one row per kind
    Given "test-device" reported its "trainer" "KICKR CORE 1234" as "connected"
    And "test-device" reported its "heart-rate" "HRM-Pro 42" as "reconnecting"
    When I open the device indicator
    Then the device setup shows:
      | device             | detail                      | status        |
      | Power Meter        | KICKR CORE 1234             | Connected     |
      | Smart Trainer      | KICKR CORE 1234             | Connected     |
      | Heart Rate Monitor | HRM-Pro 42                  | Reconnecting… |

  Scenario: The power box follows the trainer
    Given "test-device" reported its "trainer" "KICKR CORE 1234" as "reconnecting"
    When I open the device indicator
    Then the device setup shows:
      | device             | detail                          | status        |
      | Power Meter        | KICKR CORE 1234                 | Reconnecting… |
      | Smart Trainer      | KICKR CORE 1234                 | Reconnecting… |
      | Heart Rate Monitor | e.g. Polar, Garmin, Apple Watch | Not set up    |

  Scenario: While the trainer is searched for, power is searched for too
    When "test-device" reports its "trainer" "KICKR CORE 1234" as "searching"
    Then the device indicator shows:
      | device     | state     |
      | Trainer    | searching |
      | Power      | searching |
      | Heart rate | none      |

  Scenario: Kinds without a device are not set up
    When I open the device indicator
    Then the device setup shows:
      | device             | detail                          | status     |
      | Power Meter        | e.g. Assioma, Favero, Stages    | Not set up |
      | Smart Trainer      | e.g. Wahoo, Tacx, Elite         | Not set up |
      | Heart Rate Monitor | e.g. Polar, Garmin, Apple Watch | Not set up |

  Scenario: The device setup follows the devices while it is open
    Given I open the device indicator
    When "test-device" reports its "trainer" "KICKR CORE 1234" as "connected"
    Then the device setup shows the "Smart Trainer" as "Connected"

  Scenario: Continue leads back to the main screen
    Given I open the device indicator
    When I press "Continue"
    Then the "main" screen is shown

  Scenario: Back on the main screen the indicator still knows every device
    Given "test-device" reported its "trainer" "KICKR CORE 1234" as "connected"
    And "test-device" reported its "heart-rate" "HRM-Pro 42" as "connected"
    And I open the device indicator
    When I press "Done"
    Then the device indicator shows:
      | device     | state     |
      | Trainer    | connected |
      | Power      | connected |
      | Heart rate | connected |

  Scenario: The main screen does not know the indicator
    Then the slot "main/status" contains the contribution "ui-devices/device-indicator"
    And the manifest and the client of "ui-main-screen" mention none of "ui-devices, device-registry, setup"
