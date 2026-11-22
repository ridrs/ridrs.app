@ui
Feature: The plugins page of the settings
  Settings › Plugins lists the plugins of the app and the installed ones (`plugins.list`, ADR
  0106), each with a switch: a change takes effect at the next start, and the page says so. The
  plugin manager and the settings stay on. A plugin ZIP dragged onto the window shows what it asks
  for on the drop layer, and letting go installs it. The page is off the ride path: a pointer may
  be needed (AGENTS.md rule 12).

  Background:
    Given the ridrs plugins "activity-session, ui-main-screen, ui-main-menu, ui-main-top-bar, ui-tile-ride-start, ui-activity-screen, ui-landscape-demo, ui-settings, plugins-manager, file-drop, ui-file-drop, video-source-scenic, download-ride-package, data-archive-node, storage-media-node" together with the simulated drop
    And the host has started
    And the main screen is 1400 px wide
    And the ridrs UI is shown

  Scenario: The settings list the plugins with a switch each
    When I press "Settings"
    And I open the tab "Plugins"
    Then the button "download-ride-package" is on
    And the button "plugins-manager" is disabled
    And the button "ui-settings" is disabled

  Scenario: A plugin switched off says it stops at the next start
    When I press "Settings"
    And I open the tab "Plugins"
    And I press "download-ride-package"
    Then the button "download-ride-package" is off
    And the plugins page reads "Takes effect at the next start"
    And the plugin "download-ride-package" is "bundled, off, running"

  Scenario: A dragged plugin shows what it asks for, and letting go installs it
    When the rider drags the plugin "test-youtube-downloader" onto the window
    Then the drop layer says "Let go to install the plugin Test YouTube downloader"
    And the drop layer shows the tile "Test YouTube downloader"
    When the rider lets go of it
    Then the plugin "test-youtube-downloader" is "installed, on, stopped"
