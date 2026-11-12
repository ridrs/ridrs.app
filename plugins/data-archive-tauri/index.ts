// SPDX-License-Identifier: AGPL-3.0-or-later

import { assertAppFilePath, type DataFetchProgress, dataArchiveCapability, definePlugin } from '@ridrs/contracts';
import { Channel, invoke } from '@tauri-apps/api/core';

/** A channel for the unpacking's progress from Rust. */
function progressChannel(onProgress?: (progress: DataFetchProgress) => void) {
  const channel = new Channel<{ received: number; size: number | null }>();
  channel.onmessage = ({ received, size }) => onProgress?.({ received, size: size ?? undefined });
  return channel;
}

/**
 * `data.archive` in the native app: the app's `media_extract` command unpacks a ZIP of the media
 * storage in Rust, ZIP64 included, refusing names that leave the folder (crates/ridrs-media). Its progress comes over a channel.
 */
export default definePlugin({
  initialize(ctx) {
    ctx.capabilities.provide(dataArchiveCapability, {
      extract: (archive, directory, onProgress) =>
        invoke<string[]>('media_extract', {
          archive: assertAppFilePath(archive),
          directory: assertAppFilePath(directory),
          onProgress: progressChannel(onProgress),
        }),
    });
  },
});
