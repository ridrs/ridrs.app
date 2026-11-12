// SPDX-License-Identifier: AGPL-3.0-or-later

import { dataDropCapability, definePlugin } from '@ridrs/contracts';
import { Channel, invoke } from '@tauri-apps/api/core';
import { type ProgressChannel, watchDrags } from './drop.ts';

/** A channel for a copy's progress from Rust. */
const progressChannel: ProgressChannel = (onProgress) => {
  const channel = new Channel<{ received: number; size: number | null }>();
  channel.onmessage = ({ received, size }) => onProgress?.({ received, size: size ?? undefined });
  return channel;
};

let stopWatching: (() => void) | undefined;

/**
 * `data.drop` in the native app (ADR 0093): the page's HTML5 drags of files, with what they hold
 * read in Rust from the drag pasteboard while they hover (`media_drop_*`); the WebView sees names,
 * sizes and the small files a preview reads. A dropped file is copied like a chosen one
 * (`media_pick_copy`).
 */
export default definePlugin({
  initialize(ctx) {
    const watched = watchDrags(window, invoke, progressChannel, (error) =>
      ctx.logger.warn({ error: String(error) }, 'data-drop-tauri: a drag could not be read'),
    );
    stopWatching = watched.stop;
    ctx.capabilities.provide(dataDropCapability, watched.drop);
  },
  dispose() {
    stopWatching?.();
    stopWatching = undefined;
  },
});
