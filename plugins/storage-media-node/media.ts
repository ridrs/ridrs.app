// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync } from 'node:fs';
import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertAppFilePath, type MediaFiles } from '@ridrs/contracts';
import { readPackageEntry, routeEntries } from './entries.ts';

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
      const file = location(path);
      if (!existsSync(file)) {
        // Below a route's folder, an entry of its package (ADR 0094).
        const entry = await readPackageEntry(root, assertAppFilePath(path));
        if (entry) return entry;
      }
      return new Uint8Array(await readFile(file));
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
    entries: (folder) => routeEntries(location(folder)),
    async writeFrom(url, path) {
      const target = location(path);
      await mkdir(dirname(target), { recursive: true });
      if (url.startsWith('file:')) {
        await copyFile(fileURLToPath(url), target);
        return;
      }
      const answer = await fetch(url);
      if (!answer.ok) throw new Error(`${url}: ${answer.status}`);
      await writeFile(target, new Uint8Array(await answer.arrayBuffer()));
    },
  };
}
