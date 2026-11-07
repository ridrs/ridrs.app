// SPDX-License-Identifier: AGPL-3.0-or-later

import { assertAppFilePath, dataArchiveCapability, definePlugin } from '@ridrs/contracts';
import { invoke } from '@tauri-apps/api/core';

/**
 * `data.archive` in the native app: the app's `media_extract` command unpacks a ZIP of the media
 * storage in Rust, ZIP64 included, refusing names that leave the folder (crates/ridrs-media).
 */
export default definePlugin({
  initialize(ctx) {
    ctx.capabilities.provide(dataArchiveCapability, {
      extract: (archive, directory) =>
        invoke<string[]>('media_extract', {
          archive: assertAppFilePath(archive),
          directory: assertAppFilePath(directory),
        }),
    });
  },
});
