// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  assertAppFilePath,
  type DataFetchProgress,
  dataPickCapability,
  definePlugin,
  type FilePeek,
  type PeekedEntry,
} from '@ridrs/contracts';
import { Channel, invoke } from '@tauri-apps/api/core';

/** A channel for a copy's progress from Rust. */
function progressChannel(onProgress?: (progress: DataFetchProgress) => void) {
  const channel = new Channel<{ received: number; size: number | null }>();
  channel.onmessage = ({ received, size }) => onProgress?.({ received, size: size ?? undefined });
  return channel;
}

/** What `media_pick_peek` finds; `media_pick_read` gives the bytes of what is readable. */
interface Peeked {
  readonly entries:
    | readonly {
        readonly name: string;
        readonly size: number;
        readonly readable: boolean;
        readonly stored: boolean;
      }[]
    | null;
  readonly readable: boolean;
}

/** What a preview or an import may read of the chosen file of `token`, as a dragged one's (ADR 0093). */
async function peek(token: string): Promise<FilePeek> {
  const read = async (entry?: string) =>
    new Uint8Array(await invoke<ArrayBuffer>('media_pick_read', { token, entry: entry ?? null }));
  const peeked = await invoke<Peeked>('media_pick_peek', { token });
  if (peeked.entries) {
    const entries: PeekedEntry[] = [];
    for (const { name, size, readable, stored } of peeked.entries) {
      entries.push(readable ? { name, size, stored, bytes: await read(name) } : { name, size, stored });
    }
    return { entries };
  }
  return peeked.readable ? { bytes: await read() } : {};
}

interface Picked {
  readonly token: string;
  readonly name: string;
  readonly size: number;
}

/**
 * `data.pick` in the native app (ADR 0090): the app's `media_pick` command opens the system's
 * open dialog in Rust and keeps the chosen file's place there; `media_pick_peek` looks into it,
 * `media_pick_copy` copies it into the media storage (a clone on one volume of a Mac) and
 * `media_pick_extract` unpacks it there (ADR 0094), their progress over a channel. The WebView
 * sees the file's name, its size and what a peek reads, never its place.
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
          peek: () => peek(picked.token),
          copyTo: (target, onProgress) =>
            invoke<void>('media_pick_copy', {
              token: picked.token,
              target: assertAppFilePath(target),
              onProgress: progressChannel(onProgress),
            }),
          extractTo: (directory, onProgress) =>
            invoke<void>('media_pick_extract', {
              token: picked.token,
              directory: assertAppFilePath(directory),
              onProgress: progressChannel(onProgress),
            }),
        };
      },
    });
  },
});
