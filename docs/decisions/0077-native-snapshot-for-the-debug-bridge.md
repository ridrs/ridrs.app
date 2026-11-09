<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0077: A Native Snapshot for the Debug Bridge

Status: **accepted** on 2026-11-09 by the maintainer ("alle Empfehlungen sind ok"), on their request for an interface that lets Claude test the running Mac app as well as the built-in browser.

## Context

The debug bridge (`apps/native/debug-bridge`, `pnpm debug:app`) lets a developer or Claude read logs, the layout audit and the accessibility tree of the running Tauri window, and run scripts in it. A screenshot needs pixels of the WKWebView, which the page cannot draw itself (no DOM-to-image that is faithful to fonts, gradients and video), and the system screenshot tools need the screen-recording permission and capture other windows too.

## Decision

- **A native snapshot of the WKWebView** in `src/debug_snapshot.rs`, as the Tauri command `debug_snapshot`, compiled only in debug builds on macOS (`cfg(all(debug_assertions, target_os = "macos"))`). A release build has neither the command nor the code.
- **Five crates, macOS only** (`[target.'cfg(target_os = "macos")'.dependencies]`): `objc2`, `block2`, `objc2-app-kit`, `objc2-foundation` and `objc2-web-kit`. They are the crates and versions Tauri and wry already use for WKWebView, so the lock file gains no new version; the feature lists are cut to what the snapshot calls (`WKSnapshotConfiguration`, `NSBitmapImageRep` and the types between them).
- **No other way was chosen:** a webview-side DOM rasteriser draws differently from WebKit; `screencapture` needs a permission the rider would have to grant to a terminal.

## Consequences

- The crates stay in the dependency list of a release build on the Mac, but nothing calls them there; `cargo` links only what is used.
- When Tauri or wry move to another `objc2` major version, the versions here move with them (the build fails on a second copy, so it shows).
