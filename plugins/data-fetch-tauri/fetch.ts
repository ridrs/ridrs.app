// SPDX-License-Identifier: AGPL-3.0-or-later

import { assertAppFilePath, type DataFetch, type DataFetchProgress } from '@ridrs/contracts';
import { Channel, invoke } from '@tauri-apps/api/core';

/**
 * `data.fetch` in the native app: the app's `media_fetch` command downloads in Rust, straight into
 * the media storage, resumable (crates/ridrs-media/src/fetch.rs). Progress comes over a channel;
 * aborting the signal cancels the download and keeps its part.
 */
export function createTauriFetch(): DataFetch {
  let jobs = 0;
  return {
    async fetch(job, onProgress, signal) {
      const id = `fetch-${++jobs}`;
      const progress = new Channel<{ received: number; size: number | null }>();
      progress.onmessage = ({ received, size }) =>
        onProgress?.({ received, size: size ?? undefined } satisfies DataFetchProgress);
      const cancel = () => void invoke('media_fetch_cancel', { job: id });
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        const result = await invoke<{ size: number; etag: string | null }>('media_fetch', {
          job: id,
          url: job.url,
          target: assertAppFilePath(job.target),
          expectedEtag: job.expected?.etag ?? null,
          onProgress: progress,
        });
        return { size: result.size, etag: result.etag ?? undefined };
      } finally {
        signal?.removeEventListener('abort', cancel);
      }
    },
  };
}
