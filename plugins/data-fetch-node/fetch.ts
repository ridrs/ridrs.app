// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { DataFetch, MediaFiles } from '@ridrs/contracts';

/** What the part file was fetched against: a resume asks for the same version of the source. */
interface PartInfo {
  readonly url: string;
  readonly etag?: string;
}

async function partInfo(file: string): Promise<PartInfo | undefined> {
  return readFile(file, 'utf8').then(
    (text) => JSON.parse(text) as PartInfo,
    () => undefined,
  );
}

const sizeOf = (file: string) => stat(file).then(
  (info) => info.size,
  () => 0,
);

/** The total of a `206` from its `Content-Range: bytes a-b/total`. */
const totalOf = (range: string | null) => Number(range?.split('/')[1] ?? Number.NaN);

/**
 * `data.fetch` with Node's `fetch`. The data goes to `<target>.part`, what it was fetched against
 * to `<target>.part.json`. A second fetch of the same URL goes on from the part's end with
 * `Range` and `If-Range`: a source that changed since answers with all of it, which starts over,
 * as does an ETag other than the expected one.
 */
export function createNodeFetch(media: MediaFiles): DataFetch {
  return {
    async fetch(job, onProgress, signal) {
      const target = media.location(job.target);
      const part = `${target}.part`;
      const info = `${target}.part.json`;
      await mkdir(dirname(target), { recursive: true });

      const before = await partInfo(info);
      const resumable =
        before?.url === job.url &&
        before.etag !== undefined &&
        (job.expected?.etag === undefined || job.expected.etag === before.etag);
      let offset = resumable ? await sizeOf(part) : 0;
      const headers: Record<string, string> =
        offset > 0 && before?.etag ? { Range: `bytes=${offset}-`, 'If-Range': before.etag } : {};

      // Ready before the request: a stream that breaks drops what has not been read, so the
      // body is read from the moment it arrives.
      const file = await open(part, offset > 0 ? 'r+' : 'w');
      let received = offset;
      let size = Number.NaN;
      let etag: string | undefined;
      let noted: Promise<void> = Promise.resolve();
      try {
        await file.truncate(offset);
        const response = await fetch(job.url, { headers, signal });
        if (response.status !== 200 && response.status !== 206) {
          throw new Error(`${job.url}: HTTP ${response.status}`);
        }
        etag = response.headers.get('etag') ?? undefined;
        size =
          response.status === 206
            ? totalOf(response.headers.get('content-range'))
            : Number(response.headers.get('content-length') ?? Number.NaN);
        noted = writeFile(info, JSON.stringify({ url: job.url, etag } satisfies PartInfo));
        const chunks = response.body?.[Symbol.asyncIterator]();
        if (!chunks) {
          throw new Error(`${job.url}: no body`);
        }
        if (response.status === 200 && offset > 0) {
          received = 0;
          await file.truncate(0);
        }
        for (let next = await chunks.next(); !next.done; next = await chunks.next()) {
          const chunk = next.value as Uint8Array;
          await file.write(chunk, 0, chunk.length, received);
          received += chunk.length;
          onProgress?.({ received, size: Number.isFinite(size) ? size : undefined });
        }
        await file.sync();
      } finally {
        await file.close();
        await noted;
      }
      if (Number.isFinite(size) && received !== size) {
        throw new Error(`${job.url}: ${received} of ${size} bytes`);
      }
      await rename(part, target);
      await rm(info, { force: true });
      return { size: received, etag };
    },
  };
}
