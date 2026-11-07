// SPDX-License-Identifier: AGPL-3.0-or-later

import { assertAppFilePath, type MediaFiles } from '@ridrs/contracts';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';

/** The app's scheme for media in the WebView (crates/ridrs-media/src/protocol.rs). */
const SCHEME = 'ridrs-media';

/**
 * `storage.media` in the native app: `media` in the app data directory, through the app's
 * `media_*` commands (crates/ridrs-media). The app's `ridrs-media://` scheme serves its files to
 * the WebView by range; a URL names the media path, never a path of the device (ADR 0067).
 */
export function createTauriMediaFiles(root: string): MediaFiles {
  const location = (path: string) => `${root}/${assertAppFilePath(path)}`;
  return {
    exists: (path) => invoke<boolean>('media_exists', { path: assertAppFilePath(path) }),
    async read(path) {
      return new Uint8Array(await invoke<ArrayBuffer>('media_read', { path: assertAppFilePath(path) }));
    },
    async write(path, bytes) {
      await invoke('media_write', { path: assertAppFilePath(path), bytes: [...bytes] });
    },
    async move(from, to) {
      await invoke('media_move', { from: assertAppFilePath(from), to: assertAppFilePath(to) });
    },
    async remove(path) {
      await invoke('media_remove', { path: assertAppFilePath(path) });
    },
    location,
    url: (path) => convertFileSrc(assertAppFilePath(path), SCHEME),
  };
}
