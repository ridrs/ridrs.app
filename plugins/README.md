<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# Plugins

Production plugins live directly under this directory (starting in Phase 2).
Each plugin folder must contain a `manifest.json` file and the entry module declared in `manifest.entry`.

Folder prefixes (`device-`, `metric-`, `ui-`, `example-`, etc.) are a naming convention only; `manifest.json` is the single source of truth for plugin identity, types, provided capabilities, and required capabilities.
