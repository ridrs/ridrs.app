<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0041: Window Size and Position with `tauri-plugin-window-state`

The native app keeps its main window's size, position and maximized/fullscreen state across restarts with the official Tauri plugin **tauri-plugin-window-state** 2.5.0 (Apache-2.0 OR MIT), registered in `apps/native/src-tauri/src/lib.rs` on desktop only (`#[cfg(desktop)]`; the crate is a desktop-only target dependency). Only the Rust side is used, so the capability files grant no plugin permission and there is no JS package. The plugin saves the state on exit and restores it when the window is created; the window's `minWidth` / `minHeight` in `tauri.conf.json` (960 × 600) still apply, so a restored window is never smaller than the layout needs.

Not chosen: own code around `WindowEvent::Moved` / `Resized` and a settings file, which would re-implement what the official plugin already handles (multiple monitors, a monitor that is gone on the next start).

The companion app gets the minimum size (360 × 640) but not the plugin: it runs on phones, and its desktop build is for development.
