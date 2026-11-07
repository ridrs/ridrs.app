// SPDX-License-Identifier: AGPL-3.0-or-later

import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertAppFilePath, type MediaFiles } from '@ridrs/contracts';

/** `storage.media` on a folder of the device: media paths below `root`, file URLs for the UI. */
export function createNodeMediaFiles(root: string): MediaFiles {
  const location = (path: string): string => join(root, ...assertAppFilePath(path).split('/'));
  return {
    async exists(path) {
      return access(location(path)).then(
        () => true,
        () => false,
      );
    },
    async read(path) {
      return new Uint8Array(await readFile(location(path)));
    },
    async write(path, bytes) {
      const file = location(path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, bytes);
    },
    async move(from, to) {
      const target = location(to);
      await mkdir(dirname(target), { recursive: true });
      await rename(location(from), target);
    },
    async remove(path) {
      await rm(location(path), { recursive: true, force: true });
    },
    location,
    url: (path) => pathToFileURL(location(path)).href,
  };
}
