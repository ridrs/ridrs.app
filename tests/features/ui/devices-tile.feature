@devices @ui
Feature: The devices tile on the main screen
  The main screen shows a tile with one row per kind of device: trainer, power and heart rate,
  each with its state. The trainer measures power too and is the only source of power so far, so
  the power row shows the trainer, the same way as in its own row: searching while the trainer
  is searched for. A row opens the device setup with that kind's details; All devices opens the
  setup with one row per kind. Continue (or Done, once everything is connected) leads back to the
  main screen.

  Background:
    Given the ridrs plugins "activity-session, device-registry, ui-main-screen, ui-tile-ride-start, ui-activity-screen, ui-devices" together with a test device plugin "test-device"
    And the host has started
    And the ridrs UI is shown

  Scenario: Without devices the tile invites the rider to set them up
    Then the devices tile says "Set up your devices"

  Scenario: The tile shows one row per kind
    When "test-device" reports its "trainer" "KICKR CORE 1234" as "connected"
    And "test-device" reports its "heart-rate" "HRM-Pro 42" as "searching"
    Then the devices tile shows:
      | device     | state     |
      | Trainer    | connected |
      | Power      | connected |
      | Heart rate | searching |

  Scenario: All devices opens the device setup
    When I open the device setup from the main screen
    Then the "setup" screen is shown

  Scenario: A row opens the details of its kind
    Given "test-device" reported its "heart-rate" "HRM-Pro 42" as "connected"
    When I open the "Heart rate" row of the devices tile
    Then the "setup" screen is shown
    And the details are headed "Heart Rate Monitor"

  Scenario: The device setup shows one row per kind
    Given "test-device" reported its "trainer" "KICKR CORE 1234" as "connected"
    And "test-device" reported its "heart-rate" "HRM-Pro 42" as "reconnecting"
    When I open the device setup from the main screen
    Then the device setup shows:
      | device             | detail                      | status        |
      | Power Meter        | KICKR CORE 1234             | Connected     |
      | Smart Trainer      | KICKR CORE 1234             | Connected     |
      | Heart Rate Monitor | HRM-Pro 42                  | Reconnecting… |

  Scenario: The power row follows the trainer
    Given "test-device" reported its "trainer" "KICKR CORE 1234" as "reconnecting"
    When I open the device setup from the main screen
    Then the device setup shows:
      | device             | detail                          | status        |
      | Power Meter        | KICKR CORE 1234                 | Reconnecting… |
      | Smart Trainer      | KICKR CORE 1234                 | Reconnecting… |
      | Heart Rate Monitor | e.g. Polar, Garmin, Apple Watch | Not set up    |

  Scenario: While the trainer is searched for, power is searched for too
    When "test-device" reports its "trainer" "KICKR CORE 1234" as "searching"
    Then the devices tile shows:
      | device     | state     |
      | Trainer    | searching |
      | Power      | searching |
      | Heart rate | none      |

  Scenario: Kinds without a device are not set up
    When I open the device setup from the main screen
    Then the device setup shows:
      | device             | detail                          | status     |
      | Power Meter        | e.g. Assioma, Favero, Stages    | Not set up |
      | Smart Trainer      | e.g. Wahoo, Tacx, Elite         | Not set up |
      | Heart Rate Monitor | e.g. Polar, Garmin, Apple Watch | Not set up |

  Scenario: The device setup follows the devices while it is open
    Given I open the device setup from the main screen
    When "test-device" reports its "trainer" "KICKR CORE 1234" as "connected"
    Then the device setup shows the "Smart Trainer" as "Connected"

  Scenario: Continue leads back to the main screen
    Given I open the device setup from the main screen
    When I press "Continue"
    Then the "main" screen is shown

  Scenario: Back on the main screen the tile still knows every device
    Given "test-device" reported its "trainer" "KICKR CORE 1234" as "connected"
    And "test-device" reported its "heart-rate" "HRM-Pro 42" as "connected"
    And I open the device setup from the main screen
    When I press "Done"
    Then the devices tile shows:
      | device     | state     |
      | Trainer    | connected |
      | Power      | connected |
      | Heart rate | connected |

  Scenario: The main screen does not know the tile
    Then the tile "ui-devices/devices" is shown on the main screen
    And the manifest and the client of "ui-main-screen" mention none of "ui-devices, device-registry, setup"
