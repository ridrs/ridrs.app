@core
Feature: Plugins keep machine settings only when their manifest says so
  A plugin keeps configuration of this machine in settings documents through
  `ctx.settings.machine` (ADR 0054), granted by the manifest field `persistence`. Only plugins on
  the input side may declare it: values that affect the simulation enter as inputs.

  Scenario: A physics plugin may not keep settings
    Given a plugin folder "physics-probe" whose manifest declares the types "physics" and the persistence "machine"
    When the host discovers plugins in the plugin directory
    Then the discovery reported an "invalid-manifest" problem for folder "physics-probe" mentioning "persistence"

  Scenario: A device plugin may keep settings
    Given a plugin folder "device-probe" whose manifest declares the types "device" and the persistence "machine"
    When the host discovers plugins in the plugin directory
    Then the discovery reported no problems

  Scenario: Without the declaration, a plugin cannot reach the settings
    Given a probe plugin "test-device" of type "device" without persistence reads its machine settings
    Then the probe's settings call failed with "permission-denied"

  Scenario: Settings written by a plugin are read back after a restart
    Given a probe plugin "test-device" of type "device" with persistence writes the machine setting "favourite" as "KICKR"
    When the host restarts
    Then the probe reads the machine setting "favourite" as "KICKR"
    And the machine settings hold the file "config/machine/test-device/favourite.json"
