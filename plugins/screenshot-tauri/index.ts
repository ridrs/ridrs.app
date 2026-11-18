// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  definePlugin,
  RIDE_SCREENSHOT_CAPTURE_KEY,
  rideScreenshotCaptureState,
  rideScreenshotService,
  storageAppFilesCapability,
} from '@ridrs/contracts';
import { RECORDINGS_DIRECTORY } from '@ridrs/recording';
import { invoke } from '@tauri-apps/api/core';
import { createRideScreenshot } from './screenshot.ts';

/**
 * How long the UI gets to draw itself for the snapshot once it was told: the state reaches it
 * after a microtask and React renders in a task of its own; then two frames, so the change is
 * painted before WebKit takes the snapshot.
 */
const SETTLE_MS = 50;

/** A hidden web view draws no frames: a frame is waited for this long at most. */
const FRAME_MS = 100;

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, FRAME_MS);
    requestAnimationFrame(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * `ride.screenshot` in the native app (ADR 0102): the app's `ride_screenshot` command takes the
 * native snapshot of the web view and writes it to the recordings as a JPEG. While it does,
 * `ride.screenshot-capture` tells the UI to leave see-through WebGPU canvases, which the
 * snapshot would fill with black.
 */
export default definePlugin({
  initialize(ctx) {
    const files = ctx.capabilities.get(storageAppFilesCapability);
    const take = createRideScreenshot({
      list: async () => (await files.list(RECORDINGS_DIRECTORY)).map((entry) => entry.path),
      capture: (on) => {
        if (on) ctx.state.set(rideScreenshotCaptureState, RIDE_SCREENSHOT_CAPTURE_KEY, {});
        else ctx.state.remove(rideScreenshotCaptureState, RIDE_SCREENSHOT_CAPTURE_KEY);
      },
      settle: async () => {
        await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
        await nextFrame();
        await nextFrame();
      },
      snapshot: (path) => invoke('ride_screenshot', { path }),
    });
    ctx.services.provide(rideScreenshotService, ({ startedAt }) => take(startedAt));
  },
});
