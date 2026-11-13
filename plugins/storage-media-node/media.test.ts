// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TextReader, Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { describe, expect, it } from 'vitest';
import { createNodeMediaFiles } from './media.ts';

describe('createNodeMediaFiles', () => {
  const root = mkdtempSync(join(tmpdir(), 'ridrs-media-test-'));
  const media = createNodeMediaFiles(root);

  it('writes, moves and removes files and folders below its root', async () => {
    await media.write('videos/a/package.zip', new Uint8Array([1, 2, 3]));
    await media.move('videos/a/package.zip', 'videos/a/route/video.mp4');
    expect(await media.exists('videos/a/package.zip')).toBe(false);
    expect([...(await media.read('videos/a/route/video.mp4'))]).toEqual([1, 2, 3]);
    expect(media.location('videos/a/route/video.mp4')).toBe(join(root, 'videos', 'a', 'route', 'video.mp4'));
    expect(media.url('videos/a/route/video.mp4')).toMatch(/^file:\/\/.*\/videos\/a\/route\/video\.mp4$/);
    await media.remove('videos/a');
    expect(await media.exists('videos/a/route/video.mp4')).toBe(false);
    await media.remove('videos/missing');
  });

  it("lists a route's entries: its package's, replaced or added to by the files beside it", async () => {
    const zip = new ZipWriter(new Uint8ArrayWriter());
    await zip.add('Col.xml', new TextReader('old'));
    await zip.add('Col.mp4', new Uint8ArrayReader(new Uint8Array(5)), { level: 0 });
    await media.write('videos/b/route/route.ride', await zip.close());
    await media.write('videos/b/route/col.XML', new TextEncoder().encode('a new control file'));
    await media.write('videos/b/route/pictures/preview.jpg', new Uint8Array(3));
    await media.write('videos/b/route/.DS_Store', new Uint8Array(1));
    expect(await media.entries('videos/b/route')).toEqual([
      { path: 'col.XML', size: 18 },
      { path: 'Col.mp4', size: 5, stored: true },
      { path: 'pictures/preview.jpg', size: 3 },
    ]);
    expect(await media.entries('videos/b/missing')).toEqual([]);
    // Read like files: an entry of the package, and a file beside it before its entry.
    expect(await media.read('videos/b/route/Col.mp4')).toEqual(new Uint8Array(5));
    expect(new TextDecoder().decode(await media.read('videos/b/route/Col.xml'))).toBe('a new control file');
    await expect(media.read('videos/b/route/Col.gpx')).rejects.toThrow();
  });

  it('lists a folder without a package as its files', async () => {
    await media.write('videos/c/route/route.xml', new Uint8Array(2));
    await media.write('videos/c/route/video.mp4', new Uint8Array(4));
    expect(await media.entries('videos/c/route')).toEqual([
      { path: 'route.xml', size: 2 },
      { path: 'video.mp4', size: 4 },
    ]);
  });

  it('refuses paths that leave its root', () => {
    expect(() => media.location('../outside')).toThrow('Invalid app file path');
  });
});
