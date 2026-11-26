Feature: Plugins the rider switches off, installs and removes
  The plugin manager (`plugins-manager`, ADR 0106) lists every plugin of the app and every plugin
  the rider installed as a key of the app state `plugins.list`. The rider switches a plugin off
  or on and removes an installed one; the choices are kept in the app files
  (`config/plugin-choices.json`) and take effect at the next start. A plugin comes as a ZIP of its
  manifest and one bundled ES module: dragged onto the window it shows what it asks for, and let go
  it is installed into the media storage (`plugins/<id>/`) and granted the programs its manifest
  names, which it starts through `process.run`.

  Here the dragged files are simulated; the installed plugin is a downloader of YouTube videos
  that runs `node` (tests/fixtures/plugins/loadable), and ridrs Scenic is simulated.

  Background:
    Given the ridrs plugins "plugins-manager, file-drop, video-source-scenic, download-ride-package, process-run-node, data-archive-node, storage-media-node" together with the simulated drop

  Scenario: The plugins of the app are listed, on and running
    When the host has started
    Then the plugin "download-ride-package" is "bundled, on, running"
    And the plugin "plugins-manager" is "bundled, on, running, locked"

  Scenario: A plugin switched off stops at the next start
    Given the host has started
    And the video source "video-source-scenic" offers 23 routes
    When the UI bridge calls "plugins.set-enabled" with '{"key":"download-ride-package","enabled":false}'
    Then the plugin "download-ride-package" is "bundled, off, running"
    When ridrs restarted
    Then the plugin "download-ride-package" is "bundled, off, stopped"
    And the video source "video-source-scenic" offers 0 routes
    When the UI bridge calls "plugins.set-enabled" with '{"key":"download-ride-package","enabled":true}'
    And ridrs restarted
    Then the plugin "download-ride-package" is "bundled, on, running"

  Scenario: The plugin manager stays on
    Given the host has started
    When the UI bridge calls "plugins.set-enabled" with '{"key":"plugins-manager","enabled":false}'
    Then the call was rejected with "service-failed"
    And the plugin "plugins-manager" is "bundled, on, running, locked"

  Scenario: A plugin names the plugins that cannot start without it
    Given a test plugin "test-provider" provides "test.thing" and a test plugin "test-user" requires it
    When the host has started
    Then the plugin "test-provider" is needed by "test-user"

  Scenario: A dragged plugin shows what it asks for
    Given the host has started
    When the rider drags the plugin "test-youtube-downloader" onto the window
    And the dragged files are read
    Then the dragged file is the plugin "Test YouTube downloader" 1.0.0, asking for "process.run" and the programs "node"

  Scenario: A dragged plugin is installed and starts at the next start
    Given the host has started
    And ridrs Scenic also lists the YouTube video "YTYTYTYTY02"
    And the video source "video-source-scenic" offers 23 routes
    When the rider drags the plugin "test-youtube-downloader" onto the window
    And the dragged files are read
    And the UI bridge calls "file.drop.import" with '{}'
    Then the media storage holds the installed plugin "test-youtube-downloader"
    And the plugin "test-youtube-downloader" is "installed, on, stopped"
    When ridrs restarted
    Then the plugin "test-youtube-downloader" is "installed, on, running"
    And the video source "video-source-scenic" offers 24 routes
    When the UI bridge calls "route.fetch" with '{"key":"video-source-scenic/YTYTYTYTY02"}'
    Then the route offer "video-source-scenic/YTYTYTYTY02" is "ready" once its program has run

  Scenario: An installed plugin is removed
    Given the host has started
    And the rider drags the plugin "test-youtube-downloader" onto the window
    And the dragged files are read
    And the UI bridge calls "file.drop.import" with '{}'
    And the media storage holds the installed plugin "test-youtube-downloader"
    And ridrs restarted
    And the plugin "test-youtube-downloader" is "installed, on, running"
    When the UI bridge calls "plugins.remove" with '{"key":"test-youtube-downloader"}'
    Then the call resolved with '{}'
    And the media storage holds no installed plugin "test-youtube-downloader"
    When ridrs restarted
    Then there is no plugin "test-youtube-downloader"

  Scenario: A plugin with the id of a plugin of the app is not installed
    Given the host has started
    When the rider drags the plugin "test-youtube-downloader" as "download-ride-package" onto the window
    And the dragged files are read
    Then the dragged file is refused: "The app has a plugin \"download-ride-package\" already"

  Scenario: A program the rider did not grant is not started
    Given the host has started
    When a plugin runs the program "node" through process.run
    Then the program was refused: "No installed plugin was granted the program \"node\""

  Scenario: A program under a key outlives its caller and is found again, never started twice
    Given the host has started
    And the rider drags the plugin "test-youtube-downloader" onto the window
    And the dragged files are read
    And the UI bridge calls "file.drop.import" with '{}'
    And ridrs restarted
    When the run "before the reload" starts the program "node" under the key "test:job", which writes "done" and ends with 7 after 1 s
    And the run "after the reload" starts the program "node" under the key "test:job", which ends with 0 at once
    And the run "of the new page" attaches to the key "test:job"
    Then the run "before the reload" heard "done" and ended with 7
    And the run "after the reload" heard "done" and ended with 7
    And the run "of the new page" heard "done" and ended with 7
    And nothing runs under the key "test:job"

  Scenario: The rider who cancels a program found again ends it
    Given the host has started
    And the rider drags the plugin "test-youtube-downloader" onto the window
    And the dragged files are read
    And the UI bridge calls "file.drop.import" with '{}'
    And ridrs restarted
    When the run "before the reload" starts the program "node" under the key "test:job", which writes "done" and ends with 7 after 30 s
    And the run "of the new page" attaches to the key "test:job"
    And the run "of the new page" is cancelled
    Then the run "before the reload" ended with -1
    And nothing runs under the key "test:job"
