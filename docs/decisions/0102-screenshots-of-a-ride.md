<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0102: Screenshots of a Ride

Status: proposed on 2026-11-17, on the maintainer's request for a screenshot button next to the ERG toggle that keeps its pictures in the recordings, named like `ride-20261111T122954Z-screenshot_00.jpg`.

## Context

During a ride the rider wants to keep a picture of what the window shows: the landscape (video or demo world), the HUD and the gauges. The page cannot draw itself faithfully (ADR 0077: no DOM rasteriser matches WebKit, and the video and the gauges are on WebGPU canvases, ADR 0091 and 0099). The Mac app already takes a native snapshot of its `WKWebView` for the debug bridge (ADR 0077), with crates the lock file had already.

## Decision

- **A button of its own plugin.** `ui-ride-screenshot` contributes Screenshot to `activity/control` with order 1, after the ERG toggle (order 0), so the row reads Pause, ERG, Screenshot, Finish ride. It is round and drawn like the other buttons of the ride, with Lucide's `camera` icon (ISC, like the other icons). It works with the arrow keys and Enter (AGENTS.md rule 12) and says briefly "Screenshot saved" or "Screenshot failed" in a `role="status"` bubble above it; the ride goes on either way.
- **An app service, not an event.** The button calls `ride.screenshot` with the ride's `startedAt` (from `activity.state-changed`) and gets the file back. A screenshot changes nothing of the ride, so it is not on the bus and not recorded (rule 13); a replay has no screenshots.
- **Named after the ride.** `@ridrs/recording` names it `recordings/ride-<start in UTC, as in the recording's name>-screenshot_<NN>.jpg`: numbered from 00 for each ride, the number after the highest one already there (after 99 it goes on with three digits). The name leaves out the session id the recording carries, as asked; two rides started in the same second share their numbers.
- **The native snapshot, written in Rust.** `screenshot-tauri` provides the service in the native app: it lists the recordings through `storage.app-files`, picks the name and calls the app command `ride_screenshot`, one request at a time, so two presses never pick one name. The command (`src-tauri/src/ride_screenshot.rs`) checks that the path is a `.jpg` below `recordings`, takes the `WKWebView` snapshot at the view's own size and writes it as a JPEG (quality 0.9) straight to the file, so the picture never crosses the IPC. The snapshot code moved from `debug_snapshot.rs` to `web_snapshot.rs`, which both commands use; it is now compiled in release builds on the Mac too. No new crate.
- **See-through WebGPU canvases are drawn another way for the snapshot.** The snapshot fills a WebGPU canvas configured `alphaMode: 'premultiplied'` with black (measured: the gauges of ADR 0099 came out as one black rectangle; the HDR video, `opaque`, came out right). So `screenshot-tauri` sets the app state `ride.screenshot-capture` (key `window`) before the snapshot and removes it after, also when the snapshot failed; in between it waits 50 ms and two frames for the UI to draw. While the state is there the gauges show their SVG instead of the HDR canvas (`drawsOnHdrCanvas`): the picture has them at SDR brightness, as a JPEG holds them anyway. The sequence is plain code (`plugins/screenshot-tauri/screenshot.ts`, Cucumber `ride-screenshot-capture.feature`), the Tauri call is passed in.
- **The picture is the window as it is**, buttons and HUD included; nothing is hidden for it. The live view is unchanged apart from the gauges showing their SVG for the moment of the snapshot.
- **The Mac only, for now.** Elsewhere the command answers that screenshots are not available, and the native app does not start `screenshot-tauri` and `ui-ride-screenshot` (`apps/native/src/main.ts`), so there is no button. The headless app leaves `screenshot-tauri` out like the other Tauri plugins.
- Rejected: capturing the screen with ScreenCaptureKit (the HDR glow too, but the screen recording permission for ridrs and new crates); copying the gauge canvases into the picture (whether WebKit reads a WebGPU canvas back is unproven); an opaque gauge canvas (no glass live). Also rejected: a DOM rasteriser in the web view (wrong fonts and gradients, no WebGPU canvases); `screencapture` (needs the screen recording permission and catches other windows); sending the JPEG to JS and writing it through `storage.app-files` (a megabyte as a number array over the IPC for nothing).

## Consequences

- Screenshots lie beside the recordings and are not removed with them: deleting a ride (`recording.delete`) leaves its screenshots.
- Android needs its own snapshot of the `WebView` (a Kotlin part of the app) before it can have the button.
- The focus ring of Screenshot is in a picture taken with Enter, since nothing is hidden.
