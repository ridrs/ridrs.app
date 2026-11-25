// SPDX-License-Identifier: AGPL-3.0-or-later

import { definePlugin, type VideoInterpolator, videoInterpolatorCapability } from '@ridrs/contracts';
import { Channel, invoke } from '@tauri-apps/api/core';

/** Each stretch's id while it is computed, to end it. */
let next = 0;

/**
 * `video.interpolate` in the native app (ADR 0110): the app's commands `video_interpolate` and
 * `video_interpolate_cancel` (apps/native/src-tauri/src/video_interpolate.rs) run its own program
 * `ridrs-refine`, Apple's frame rate conversion, for one stretch, and end it.
 */
const interpolator: VideoInterpolator = {
  async interpolate({ video, from, to, factor, target }, progress, signal) {
    signal.throwIfAborted();
    next += 1;
    const id = `interpolation-${next}`;
    const shares = new Channel<number>();
    shares.onmessage = (share) => progress(share);
    const cancel = () => void invoke('video_interpolate_cancel', { id }).catch(() => undefined);
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const made = await invoke<{ from: number; to: number }>('video_interpolate', {
        id,
        video,
        from,
        to,
        factor,
        target,
        onProgress: shares,
      });
      signal.throwIfAborted();
      return made;
    } catch (error) {
      signal.throwIfAborted();
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  },
};

export default definePlugin({
  initialize(ctx) {
    ctx.capabilities.provide(videoInterpolatorCapability, interpolator);
  },
});
