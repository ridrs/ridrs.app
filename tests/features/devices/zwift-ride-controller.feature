@devices @fake-timers
Feature: The Zwift Ride controller
  The Zwift Ride is a pair of two controllers, the left and the right one: two BLE devices with
  the same name and service. The left one forwards the right one's buttons, the right one does
  not forward the left's: only both connections together hear every button. The Zwift Ride plugin
  presents the pair as one device (ADR 0089): it connects both controllers, greets each with
  "RideOn" on its control point and turns their keypad packets into the buttons the pair holds
  down, under the pair's id. The pair counts as connected only once both controllers are. No
  other plugin ever sees protocol bytes.

  Rule: The pair is greeted and tells its buttons

    Background:
      Given a simulated BLE environment with the Zwift Ride pair "Zwift Ride"
      And the ridrs plugins "device-zwift-ride" running with the simulated BLE central
      And both controllers of "Zwift Ride" are connected

    Scenario: Each controller is greeted once it is listened to
      Then each controller of "Zwift Ride" received "RideOn" 1 time
      And each controller was already listened to when it received "RideOn"

    Scenario Outline: Keypad packets say which buttons are held down (<description>)
      When the left controller sends the keypad packet "<bytes>"
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
      When the left controller sends the keypad packet "23 08 fe ff ff ff 0f"
      And the left controller sends the keypad packet "23 08 fe ff ff ff 0f"
      And the left controller sends the keypad packet "23 08 ff ff ff ff 0f"
      And the left controller sends the keypad packet "23 08 ff ff ff ff 0f"
      Then the buttons held down were:
        | buttons |
        | left    |
        | none    |

    Scenario Outline: Other packets say nothing about buttons (<description>)
      When the left controller sends the packet "<bytes>"
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
      When the left controller sends the packet "<bytes>"
      Then no button change was published
      And the host reported exactly one "malformed-packet" problem for plugin "device-zwift-ride" mentioning "Zwift Ride"
      And both controllers of "Zwift Ride" are still connected

      Examples:
        | description             | bytes                |
        | truncated button map    | 23 08 ff ff          |
        | truncated analog field  | 23 08 fe ff ff ff 0f 1a 05 08 00 |

    Scenario: The plugin says it connects a controller
      Then every connection state of "device-zwift-ride" is for a "controller"

    Scenario: A reconnected controller is greeted again
      When the right controller drops the connection and refuses new connections
      Then the device status is:
        | kind       | state        | device     |
        | controller | reconnecting | Zwift Ride |
      When the right controller accepts connections again
      And 2 seconds pass
      Then the device status is:
        | kind       | state     | device     |
        | controller | connected | Zwift Ride |
      And the right controller received "RideOn" 2 times
      And the left controller received "RideOn" 1 time

    Scenario: Buttons held when a controller drops are released
      Given the left controller sends the keypad packet "23 08 fe ff ff ff 0f"
      When the right controller drops the connection and refuses new connections
      Then the buttons held down are "none"

    Scenario: Device plugins do not take each other's devices
      Given the simulated BLE environment also contains a heart-rate sensor "HRM-Pro 42"
      And the ridrs plugin "device-heart-rate" is running with the simulated BLE central
      Then the plugin "device-zwift-ride" never connected to "HRM-Pro 42"
      And the plugin "device-heart-rate" never connected to "Zwift Ride"

  Rule: The pair is one device
    Here neither controller says which side it is: the one found first is taken as the left one.

    Background:
      Given a simulated BLE environment with the Zwift Ride controllers "ride-left" and "ride-right"
      And the ridrs plugins "device-zwift-ride" running with the simulated BLE central

    Scenario: Both controllers are connected and greeted
      Then the controller with the id "ride-left" is connected
      And the controller with the id "ride-right" is connected
      And the controller with the id "ride-left" received "RideOn" 1 time
      And the controller with the id "ride-right" received "RideOn" 1 time

    Scenario: The pair has one status, under the id of the controller found first
      Then the device status is:
        | kind       | state     | device     |
        | controller | connected | Zwift Ride |
      And the device status gives the "controller" the id "ride-left"
      And the latest connection state of "device-zwift-ride" names the parts:
        | part  | id         |
        | left  | ride-left  |
        | right | ride-right |

    Scenario: The buttons of both controllers are the pair's
      When the controller with the id "ride-left" sends the keypad packet "23 08 fe ff ff ff 0f"
      And the controller with the id "ride-right" sends the keypad packet "23 08 ef ff ff ff 0f"
      Then the buttons held down on "ride-left" are "left, a"
      And no button change was published for "ride-right"

    Scenario: A button both controllers tell counts once
      When the controller with the id "ride-left" sends the keypad packet "23 08 ff df ff ff 0f"
      And the controller with the id "ride-right" sends the keypad packet "23 08 ff df ff ff 0f"
      And the controller with the id "ride-right" sends the keypad packet "23 08 ff ff ff ff 0f"
      Then the buttons held down were:
        | buttons        |
        | shift-up-right |

    Scenario: The pair is connected only once both controllers are
      When the controller with the id "ride-right" drops the connection and refuses new connections
      Then the device status is:
        | kind       | state        | device     |
        | controller | reconnecting | Zwift Ride |
      And the device status of the "controller" waits for its "right" part
      When the controller with the id "ride-right" accepts connections again
      And 2 seconds pass
      Then the device status is:
        | kind       | state     | device     |
        | controller | connected | Zwift Ride |
      And the device status of the "controller" waits for no part

    Scenario: The devices found are pairs
      Given the device setup looks for devices
      When the simulated BLE environment also contains a Zwift Ride with the id "ride-other"
      Then the controller with the id "ride-other" was never connected
      And the device status offers the "controller" devices "ride-left, ride-other"

    Scenario: Forgetting the pair lets both controllers go
      When the device setup looks for devices
      And the rider forgets the "controller"
      Then the controller with the id "ride-left" is not connected
      And the controller with the id "ride-right" is not connected
      And the device status is:
        | kind       | state     | device |
        | controller | searching |        |

  Rule: The controllers of a pair are chosen once
    The controllers say which side they are; nothing they advertise says which belong together
    (ADR 0089). In a room with two sets, the strongest left and the strongest right controller
    make the pair. Once connected, the pair is remembered with both controllers until the rider
    forgets it.

    Background:
      Given a simulated BLE environment with the Zwift Ride controllers:
        | id      | side  | signal |
        | a-left  | left  | -70    |
        | a-right | right | -72    |
        | b-left  | left  | -50    |
        | b-right | right | -75    |

    Scenario: The strongest left and the strongest right controller make the pair
      Given the ridrs plugins "device-zwift-ride" running with the simulated BLE central
      And the device setup looks for devices
      And the rider forgot the "controller"
      And the device setup stopped looking for devices
      When the device setup looks for devices
      Then the controllers with the ids "b-left, a-right" are connected
      And the controllers with the ids "a-left, b-right" are not connected

    Scenario: Two sets are found as two pairs, never as single controllers
      Given the ridrs plugins "device-zwift-ride" running with the simulated BLE central
      When the device setup looks for devices
      Then the device status lists the "controller" devices "Zwift Ride, Zwift Ride"

    Scenario: Connecting a pair found connects both its controllers
      Given the ridrs plugins "device-zwift-ride" running with the simulated BLE central
      And the device setup looks for devices
      When the rider connects the other "controller" pair
      Then the controllers with the ids "b-left, b-right" are connected
      And the controllers with the ids "a-left, a-right" are not connected
      And the device status is:
        | kind       | state     | device     |
        | controller | connected | Zwift Ride |

    Scenario: The pair is remembered with both controllers
      Given the ridrs plugins "device-zwift-ride" running with the simulated BLE central
      And the device setup looks for devices
      And the rider connected the other "controller" pair
      And the controllers with the ids "b-left, b-right" are connected
      When ridrs restarts
      Then the controllers with the ids "b-left, b-right" are connected
      And the controllers with the ids "a-left, a-right" are not connected
      And "device-zwift-ride" remembers the pair "b-left" with the controllers "b-left, b-right"

    Scenario: A forgotten pair stays forgotten after a restart
      Given the ridrs plugins "device-zwift-ride" running with the simulated BLE central
      And the device setup looks for devices
      And the rider forgot the "controller"
      When ridrs restarts
      And 60 seconds pass
      Then the controllers with the ids "a-left, a-right, b-left, b-right" are not connected

    Scenario: The two controllers remembered before the pair become one remembered pair
      Given "device-zwift-ride" remembered "b-left" and "b-right" with one link each, as before the pair
      When the ridrs plugins "device-zwift-ride" running with the simulated BLE central
      Then the controllers with the ids "b-left, b-right" are connected
      And the controllers with the ids "a-left, a-right" are not connected
      And "device-zwift-ride" remembers the pair "b-left" with the controllers "b-left, b-right"

    Scenario: An unreadable document from before the pair does not stop the start
      Given "device-zwift-ride" remembered "b-left" with its first link, and its second link's document holds "{not json", as before the pair
      When the ridrs plugins "device-zwift-ride" running with the simulated BLE central
      Then the controller with the id "b-left" is connected
      And "device-zwift-ride" remembers the pair "b-left" with the controllers "b-left, a-right"
      And the host reported a "settings-invalid" problem for plugin "device-zwift-ride"

  Rule: A pair with a controller away waits for it

    Scenario: The pair waits for the controller not found yet
      Given a simulated BLE environment with the Zwift Ride controllers:
        | id        | side |
        | ride-left | left |
      And the ridrs plugins "device-zwift-ride" running with the simulated BLE central
      Then the controller with the id "ride-left" is connected
      And the device status is:
        | kind       | state      | device     |
        | controller | connecting | Zwift Ride |
      And the device status of the "controller" waits for its "right" part
      When the simulated BLE environment also contains the right Zwift Ride controller "ride-right"
      Then the controller with the id "ride-right" is connected
      And the device status is:
        | kind       | state     | device     |
        | controller | connected | Zwift Ride |
      And the device status of the "controller" waits for no part

  Rule: Recordings from before the pair
    Before the pair was one device, each controller published its buttons under its own id. The
    raw packets are the plugin's inputs, also on replay: an old recording has no connection state
    of the pair, so each controller still stands for itself, and the plugins after it (virtual
    gears) see the same buttons as before.

    Scenario: A recording from before the pair replays as it was recorded
      Given a recording from before the pair with "device-zwift-ride" and "control-virtual-gears", in which:
        | controller | keypad packet        |
        | ride-right | 23 08 ff df ff ff 0f |
        | ride-right | 23 08 ff ff ff ff 0f |
        | ride-left  | 23 08 fe ff ff ff 0f |
      When the recording is replayed
      Then the replay is identical
      And the replay compared every "controller.buttons-changed" event of the ride, and there was at least one
      And the replay compared every "drivetrain.gear-changed" event of the ride, and there was at least one
