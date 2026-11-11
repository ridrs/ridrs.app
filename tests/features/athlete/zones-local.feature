Feature: The athlete profile on this device has zones
  The local profile (ADR 0075, 0082) holds the seven Coggan power zones by default and, with an
  LTHR, Friel's heart rate zones. Defaults are derived on read: a change of the LTHR moves them,
  unless the rider set their own zones. Writes through "athlete.profile.update" keep the zones.

  Background:
    Given the ridrs plugins "profile-local" together with a test device plugin "test-device"
    And the host has started

  Scenario: The default power zones are Coggan's seven
    Then the local athlete profile has 7 power zones with the upper bounds "55, 75, 90, 105, 120, 150, open"

  Scenario: Without an LTHR there are no heart rate zones
    Then the local athlete profile has no heart rate zones

  Scenario: Heart rate zones come from the LTHR
    When the rider sets the LTHR of the local athlete profile to 170
    Then the local athlete profile has 7 heart rate zones with the upper bounds "138, 151, 158, 168, 173, 180, open"

  Scenario: A change of the LTHR moves zones the rider did not set
    When the rider sets the LTHR of the local athlete profile to 170
    And the rider sets the LTHR of the local athlete profile to 180
    Then the local athlete profile has 7 heart rate zones with the upper bounds "146, 160, 167, 178, 184, 191, open"

  Scenario: Zones the rider set stay when the LTHR changes
    When the rider sets the LTHR of the local athlete profile to 170
    And the rider sets the local heart rate zones to "140, 160, open"
    And the rider sets the LTHR of the local athlete profile to 180
    Then the local athlete profile has 3 heart rate zones with the upper bounds "140, 160, open"

  Scenario: Power zones the rider set are kept and survive other writes
    When the rider sets the local power zones to "60, 80, 100, open"
    And the rider changes the weight in the athlete profile on this device to 70 kg
    Then the local athlete profile has 4 power zones with the upper bounds "60, 80, 100, open"
    When ridrs restarted
    Then the local athlete profile has 4 power zones with the upper bounds "60, 80, 100, open"

  Scenario: Writing the defaults again is a reset
    When the rider sets the LTHR of the local athlete profile to 170
    And the rider sets the local heart rate zones to "140, 160, open"
    And the rider sets the local power zones to "60, open"
    And the rider writes the default zones to the local athlete profile
    And the rider sets the LTHR of the local athlete profile to 180
    Then the local athlete profile has 7 power zones with the upper bounds "55, 75, 90, 105, 120, 150, open"
    And the local athlete profile has 7 heart rate zones with the upper bounds "146, 160, 167, 178, 184, 191, open"
