// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('refuses paths that leave its root', () => {
    expect(() => media.location('../outside')).toThrow('Invalid app file path');
  });
});
