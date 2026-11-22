// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DataFetch, MediaFiles, RouteDownload } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import { packageDownloader, toDownloadable } from './downloader.ts';

const ROUTE: RouteDownload = {
  id: 'source/pass',
  kind: 'ride-package',
  size: 1000,
  details: {
    url: 'https://example.org/pass.zip',
    etag: '"v1"',
    overlay: [{ path: 'preview.jpg', size: 3, sha256: 'abc', url: 'https://example.org/preview.jpg' }],
  },
};

/** A device without any route: nothing exists, nothing is listed. */
const EMPTY = {
  exists: async () => false,
  entries: async () => [],
  remove: async () => undefined,
  move: async () => undefined,
  read: async () => new Uint8Array(),
  url: (path: string) => `media:${path}`,
} as unknown as MediaFiles;

describe('toDownloadable', () => {
  it("reads a package's URL, ETag and overlay from the source's details", () => {
    expect(toDownloadable({ ...ROUTE, former: 'videos/old/pass' })).toEqual({
      id: 'source/pass',
      url: 'https://example.org/pass.zip',
      size: 1000,
      etag: '"v1"',
      overlay: [{ path: 'preview.jpg', size: 3, sha256: 'abc', url: 'https://example.org/preview.jpg' }],
      former: 'videos/old/pass',
    });
  });

  it('takes no route whose details name no URL', () => {
    expect(toDownloadable({ ...ROUTE, details: {} })).toBeUndefined();
  });
});

describe('packageDownloader', () => {
  it('downloads packages, in one quality', async () => {
    const downloader = packageDownloader({ media: EMPTY, fetch: {} as DataFetch });
    expect(downloader.kinds).toEqual(['ride-package']);
    const downloads = downloader.open(() => undefined);
    await downloads.setRoutes([ROUTE]);
    expect(await downloads.options(ROUTE.id)).toEqual([{ id: 'package', label: 'Package', size: 1000 }]);
    expect(downloads.availability(ROUTE.id)).toEqual({ state: 'fetchable', size: 1000 });
  });

  it('refuses a quality it does not have', async () => {
    const downloads = packageDownloader({ media: EMPTY, fetch: {} as DataFetch }).open(() => undefined);
    await downloads.setRoutes([ROUTE]);
    expect(downloads.refusal(ROUTE.id)).toBeUndefined();
    expect(downloads.refusal(ROUTE.id, 'package')).toBeUndefined();
    expect(downloads.refusal(ROUTE.id, '4k')).toBe('There is no quality "4k" of this route');
  });
});
