// SPDX-License-Identifier: AGPL-3.0-or-later

import { assertAppFilePath, dataPickCapability, definePlugin } from '@ridrs/contracts';
import { invoke } from '@tauri-apps/api/core';

interface Picked {
  readonly token: string;
  readonly name: string;
  readonly size: number;
}

/**
 * `data.pick` in the native app (ADR 0090): the app's `media_pick` command opens the system's
 * open dialog in Rust and keeps the chosen file's place there; `media_pick_copy` copies it into
 * the media storage (crates/ridrs-media paths). The WebView sees the file's name and size only.
 */
export default definePlugin({
  initialize(ctx) {
    ctx.capabilities.provide(dataPickCapability, {
      async pick(filter) {
        const picked = await invoke<Picked | null>('media_pick', {
          name: filter.name,
          extensions: [...filter.extensions],
        });
        if (!picked) return undefined;
        return {
          name: picked.name,
          size: picked.size,
          copyTo: (target) => invoke<void>('media_pick_copy', { token: picked.token, target: assertAppFilePath(target) }),
        };
      },
    });
  },
});
