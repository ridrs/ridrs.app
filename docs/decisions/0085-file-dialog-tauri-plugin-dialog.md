<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0085: Open and Save Dialogs in the Native App With `tauri-plugin-dialog`

Status: accepted on 2026-11-11 by the maintainer; amended on 2026-11-11 (added with the export, not the import) ([structured-workouts.md](../ideas/structured-workouts.md), sections 1, 8 and 9).

## Context

Importing workout files (phase 3) and exporting them (phase 5) need the system's open and save dialogs in the native app. The web view's `<input type="file">` opens a picker, but there is no way to save to a place the rider chooses, and the native app has no dialog plugin.

## Decision

- The official Tauri dialog plugin: Rust crate **`tauri-plugin-dialog` 2.8.4** and npm **`@tauri-apps/plugin-dialog` 2.8.4** (both `MIT OR Apache-2.0`; pure JS on the web side, ESM). 2.8.4 is the latest 2.x release and two weeks old today; the 3.0 line is alpha. It needs Tauri 2 and brings `tauri-plugin-fs`, which the app has already (ADR 0038).
- It is added with the export (phase 5), the first use that needs it: the save dialog. The import (phase 3) gets along with the web view's `<input type="file">` and dropping files, which open the system's picker in the native app too. It is registered in `src-tauri/src/lib.rs`, with a capability that allows `dialog:allow-save` (and `dialog:allow-open` once the import uses it) only.
- The UI saves through the service `files.save` (`packages/contracts/src/files.ts`): the plugin that provides it in the native app wraps the dialog and writes the chosen file; other hosts offer a download.
- Reading the chosen file and writing the export go through the fs plugin, scoped to the paths the dialog returned.
- Outside the native app (tests, the browser preview) the import falls back to `<input type="file">` and drag and drop, and the export to a download; the plugin that wraps the dialog is a host capability, so the headless tests never need it.
- Rejected: an own Rust command with `rfd` (what the plugin wraps; more code to keep); the web view's file input alone (no save dialog).

## Consequences

- NOTICE and the generated licence list gain the plugin.
- The Rust side compiles in the next `tauri dev` or `tauri build` on a machine with the toolchain.
