// SPDX-License-Identifier: AGPL-3.0-or-later

import { definePlugin, storageMediaCapability } from '@ridrs/contracts';
import { invoke } from '@tauri-apps/api/core';
import { createTauriMediaFiles } from './media.ts';

/** `storage.media` in the native app; the media root is known once, at initialization. */
export default definePlugin({
  async initialize(ctx) {
    ctx.capabilities.provide(storageMediaCapability, createTauriMediaFiles(await invoke<string>('media_root')));
  },
});
