@ui
Feature: The main screen's layout
  The main screen draws nothing of its own: it places a menu, a top bar and tiles, and each of
  them is a contribution of another plugin. Which contribution fills the menu and the top bar,
  which tiles are shown, in which order and how many of the 12 columns each spans, is configured
  in the layout of ui-main-screen (ADR 0058). A tile the layout does not name is not shown; a
  named tile of a plugin that is not running, or one with nothing to show, takes no space. The
  layout also names the screens that the content area shows instead of the top bar and the
  tiles, beside the menu; the screens themselves do not know the main screen.

  The width decides the breakpoint: wide from 1200 px, medium from 768 px, compact below. Medium
  keeps the top bar and uses each tile's medium span; compact drops the top bar and gives every
  tile the whole width. A headless DOM has no layout engine, so the steps set the width the
  layout observes and read the spans the layout declares.

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-devices, ui-ride-recovery" together with a test device plugin "test-device"
    And the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown

  Scenario: The configured plugins fill the menu and the top bar
    Then the slot "main/menu" contains the contribution "ui-main-menu/menu"
    And the slot "main/top-bar" contains the contribution "ui-main-top-bar/top-bar"

  Scenario: The tiles follow the layout's order and width
    Then the main screen's breakpoint is "wide"
    And the main screen shows the tiles:
      | tile                          | columns |
      | ui-tile-ride-start/ride-start | 8       |
      | ui-devices/devices            | 4       |

  Scenario: A tile with nothing to show takes no space
    Then the tile "ui-ride-recovery/interrupted-ride" is mounted but hidden

  Scenario: A tile that the layout does not name is not shown
    Given the plugin directory "tests/fixtures/plugins/extra-tile" is added and its plugin "fixture-ui-extra-tile" is started
    Then the main screen shows the tiles:
      | tile                          | columns |
      | ui-tile-ride-start/ride-start | 8       |
      | ui-devices/devices            | 4       |
    And no contribution "fixture-ui-extra-tile/extra" is mounted

  Scenario: A named tile of a stopped plugin leaves no gap and comes back in its place
    When the plugin "ui-tile-ride-start" is stopped
    Then the main screen shows the tiles:
      | tile               | columns |
      | ui-devices/devices | 4       |
    When the plugin "ui-tile-ride-start" is started
    Then the main screen shows the tiles:
      | tile                          | columns |
      | ui-tile-ride-start/ride-start | 8       |
      | ui-devices/devices            | 4       |

  Scenario: A medium width keeps the top bar and uses the medium spans
    Given the main screen is 1000 px wide
    Then the main screen's breakpoint is "medium"
    And the top bar is shown
    And the main screen shows the tiles:
      | tile                          | columns |
      | ui-tile-ride-start/ride-start | 12      |
      | ui-devices/devices            | 6       |

  Scenario: A compact width drops the top bar and stacks the tiles
    Given the main screen is 400 px wide
    Then the main screen's breakpoint is "compact"
    And the top bar is not shown
    And the main screen shows the tiles:
      | tile                          | columns |
      | ui-tile-ride-start/ride-start | 12      |
      | ui-devices/devices            | 12      |

  Scenario: The arrows walk through the menu first, then the global actions, then the tiles
    When I press the arrow key "Down"
    Then the focus is on "Today"
    When I press the arrow key "Down"
    Then the focus is on "Devices"
    When I press the arrow key "Down"
    Then the focus is on "Start ride"
    When I press the arrow key "Down"
    Then the focus is on "Set up your devices"

  Scenario: A screen the layout names replaces the tiles, and the menu stays
    When I press "Devices"
    Then the "setup" screen is shown
    And the slot "main/menu" contains the contribution "ui-main-menu/menu"
    And the main screen shows no tiles
    And the manifest and the client of "ui-devices" mention none of "frame, ui-main-screen, main/menu"

  Scenario: The top bar greets the rider for the time of day
    Then the top bar greets the rider for the time of day

  Scenario: The main screen does not know what fills it
    Then the manifest and the client of "ui-main-screen" mention none of "ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-devices, ui-ride-recovery, ui-training-plan, setup"
