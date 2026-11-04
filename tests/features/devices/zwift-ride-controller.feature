@devices @fake-timers
Feature: The Zwift Ride controller
  The Zwift Ride plugin connects both controllers of the pair, greets each with "RideOn" on
  its control point and turns their keypad packets into the buttons that are held down. No
  other plugin ever sees protocol bytes.

  Rule: A controller is greeted and tells its buttons

    Background:
      Given a simulated BLE environment with a Zwift Ride "Zwift Ride"
      And the ridrs plugins "device-zwift-ride" running with the simulated BLE central
      And the controller "Zwift Ride" is connected

    Scenario: The controller is greeted once it is listened to
      Then the controller "Zwift Ride" received "RideOn" 1 time
      And it was already listened to when it received "RideOn"

    Scenario Outline: Keypad packets say which buttons are held down (<description>)
      When the controller sends the keypad packet "<bytes>"
      Then the buttons held down are "<buttons>"

      Examples:
        | description              | bytes                                                                                      | buttons                |
        | all released, as sent    | 23 08 ff ff ff ff 0f 1a 04 08 00 10 00 1a 04 08 01 10 00 1a 04 08 02 10 00 1a 04 08 03 10 00 | none                   |
        | d-pad left               | 23 08 fe ff ff ff 0f 1a 04 08 00 10 00 1a 04 08 01 10 00 1a 04 08 02 10 00 1a 04 08 03 10 00 | left                   |
        | d-pad down               | 23 08 f7 ff ff ff 0f                                                                       | down                   |
        | Z                        | 23 08 ff fe ff ff 0f                                                                       | z                      |
        | left shift up            | 23 08 ff fd ff ff 0f                                                                       | shift-up-left          |
        | left on/off              | 23 08 ff ef ff ff 0f                                                                       | on-off-left            |
        | right shift up           | 23 08 ff df ff ff 0f                                                                       | shift-up-right         |
        | right power-up           | 23 08 ff ff fe ff 0f                                                                       | power-up-right         |
        | two at once              | 23 08 ee ff ff ff 0f                                                                       | left, a                |
        | paddle pulled, no button | 23 08 ff ff ff ff 0f 1a 05 08 00 10 c7 01 1a 04 08 01 10 00                                | none                   |

    Scenario: The same buttons sent again are no news
      When the controller sends the keypad packet "23 08 fe ff ff ff 0f"
      And the controller sends the keypad packet "23 08 fe ff ff ff 0f"
      And the controller sends the keypad packet "23 08 ff ff ff ff 0f"
      And the controller sends the keypad packet "23 08 ff ff ff ff 0f"
      Then the buttons held down were:
        | buttons |
        | left    |
        | none    |

    Scenario Outline: Other packets say nothing about buttons (<description>)
      When the controller sends the packet "<bytes>"
      Then no button change was published
      And the host reported no problems

      Examples:
        | description           | bytes                                                         |
        | the RideOn reply      | 52 69 64 65 4f 6e                                             |
        | battery level         | 19 10 4f                                                      |
        | heartbeat             | 15                                                            |
        | device information    | 2a 08 03 12 10 12 0e 08 18 10 00 18 90 03 22 05 00 fc 10 85 1f |
        | keypad without a map  | 23 1a 04 08 00 10 00                                          |

    Scenario Outline: Malformed keypad packets publish nothing (<description>)
      When the controller sends the packet "<bytes>"
      Then no button change was published
      And the host reported exactly one "malformed-packet" problem for plugin "device-zwift-ride" mentioning "Zwift Ride"
      And the controller "Zwift Ride" is still connected

      Examples:
        | description             | bytes                |
        | truncated button map    | 23 08 ff ff          |
        | truncated analog field  | 23 08 fe ff ff ff 0f 1a 05 08 00 |

    Scenario: The plugin says it connects a controller
      Then every connection state of "device-zwift-ride" is for a "controller"

    Scenario: A reconnected controller is greeted again
      When the controller "Zwift Ride" drops the connection and refuses new connections
      Then the connection state of "Zwift Ride" is "reconnecting"
      When the controller "Zwift Ride" accepts connections again
      And 2 seconds pass
      Then the connection state of "Zwift Ride" is "connected"
      And the controller "Zwift Ride" received "RideOn" 2 times

    Scenario: Buttons held when the link drops are released
      Given the controller sends the keypad packet "23 08 fe ff ff ff 0f"
      When the controller "Zwift Ride" drops the connection and refuses new connections
      Then the buttons held down are "none"

    Scenario: Device plugins do not take each other's devices
      Given the simulated BLE environment also contains a heart-rate sensor "HRM-Pro 42"
      And the ridrs plugin "device-heart-rate" is running with the simulated BLE central
      Then the plugin "device-zwift-ride" never connected to "HRM-Pro 42"
      And the plugin "device-heart-rate" never connected to "Zwift Ride"

  Rule: The pair is two controllers, and both are connected
    The left and the right controller are two devices with the same name and service. The
    left one forwards the right one's buttons, the right one does not forward the left's: only
    both connections together hear every button.

    Background:
      Given a simulated BLE environment with the Zwift Ride controllers "ride-left" and "ride-right"
      And the ridrs plugins "device-zwift-ride" running with the simulated BLE central

    Scenario: Both controllers are connected and greeted
      Then the controller with the id "ride-left" is connected
      And the controller with the id "ride-right" is connected
      And the controller with the id "ride-left" received "RideOn" 1 time
      And the controller with the id "ride-right" received "RideOn" 1 time

    Scenario: Each controller tells its own buttons
      When the controller with the id "ride-left" sends the keypad packet "23 08 fe ff ff ff 0f"
      And the controller with the id "ride-right" sends the keypad packet "23 08 ef ff ff ff 0f"
      Then the buttons held down on "ride-left" are "left"
      And the buttons held down on "ride-right" are "a"

    Scenario: A third controller is left alone
      Given the simulated BLE environment also contains a Zwift Ride with the id "ride-other"
      Then the controller with the id "ride-other" was never connected
