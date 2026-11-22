<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0106: Plugins the Rider Switches, Installs and Removes

Status: accepted on 2026-11-22, on the maintainer's request for a settings page with every plugin, switched on and off there, and for plugins loaded by drag and drop, the first of them a downloader of YouTube videos with yt-dlp whose code is not part of the repository (plan `route-downloaders.md`, step C).

## Context

The app's plugins were fixed at build time (`createBundledPluginSource`), and the composition root alone decided which of them do not start (`disabledPlugins`). A downloader that starts a program of the device (yt-dlp) needs native code, which a plugin loaded at run time cannot bring.

## Decision

- **Choices.** The rider's choices of plugins are a file of the app files, `config/plugin-choices.json` (`pluginChoicesSchema`): the plugins not to start, and the programs granted to each installed plugin. The composition root reads it before the host starts and adds the plugins switched off to `disabledPlugins`; a change takes effect at the next start.
- **Installed plugins.** A plugin the rider installs is a ZIP of its `manifest.json` and one bundled ES module, its entry. It is unpacked into the media storage, `plugins/<id>/` (where unpacking with its check of paths, listing and the app's media scheme exist already). The native app lists these folders as a second plugin source and loads the entry from the media scheme; the content security policy allows scripts from that scheme below `plugins/` only, and the scheme serves `.js` as `text/javascript`. Scenario hosts read the same folder with the file-system source.
- **`plugins-manager`** owns the app state `plugins.list` (one key per plugin: origin, on, running, locked, needed by, programs) and provides `plugins.set-enabled`, `plugins.remove`, `plugins.preview` and `plugins.install`. It reads the host's description (`observe-host`). The plugin manager, the settings, the main screen and menu, and the providers of `storage.app-files` stay on. A plugin with the id of a plugin of the app is not installed.
- **Drag and drop.** `file-drop` recognises a ZIP with a manifest at its top as a plugin, asks `plugins.preview`, and the drop layer shows its name, version, the capabilities it uses and the programs it starts; letting go installs it. Settings › Plugins lists the plugins with a switch each, says when a change waits for the next start, and offers Reload; it is off the ride path.
- **`process.run`** (manifest field `programs`): a program's name, granted when its plugin is installed, started without a shell, its lines heard, ended on abort. `process-run-tauri` calls the app's commands `process_run` and `process_cancel`, which read the grants again, accept a name only (no path) and look on the `PATH` and in the folders a GUI app's `PATH` lacks; `process-run-node` does the same on Node for the scenarios and the headless app.

## Consequences

- An installed plugin runs with the rights of any plugin of the app; the drop layer shows what it asks for before the rider lets go. Signatures and a sandbox wait until plugins are distributed.
- An installed plugin brings its own copy of what it imports (`@ridrs/contracts` included); a change of a contract can break it.
- The YouTube downloader lives outside the repository and only needs `process.run` and the contracts of ADR 0105.
- The grants are per app, not per caller: every plugin can start a program granted to one installed plugin.
