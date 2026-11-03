// SPDX-License-Identifier: AGPL-3.0-or-later

import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  type AppFileEntry,
  type AppFiles,
  assertAppFilePath,
  definePlugin,
  storageAppFilesCapability,
} from '@ridrs/contracts';
import envPaths from 'env-paths';

/** Overrides the data directory, e.g. for tests and the e2e. */
export const DATA_DIR_ENV = 'RIDRS_DATA_DIR';

/** The per-OS app data directory (`~/Library/Application Support/ridrs` on macOS), or the override. */
export function dataDirectory(): string {
  return process.env[DATA_DIR_ENV] || envPaths('ridrs', { suffix: '' }).data;
}

export function createNodeAppFiles(root: string): AppFiles {
  const resolvePath = (path: string): string => join(root, ...assertAppFilePath(path).split('/'));
  const withDirectory = async (path: string): Promise<string> => {
    const file = resolvePath(path);
    await mkdir(dirname(file), { recursive: true });
    return file;
  };
  return {
    async append(path, text) {
      await appendFile(await withDirectory(path), text, 'utf8');
    },
    async write(path, bytes) {
      await writeFile(await withDirectory(path), bytes);
    },
    async read(path) {
      return new Uint8Array(await readFile(resolvePath(path)));
    },
    async list(directory) {
      const dir = resolvePath(directory);
      const names = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
          return [];
        }
        throw error;
      });
      const entries: AppFileEntry[] = [];
      for (const name of names.sort()) {
        const info = await stat(join(dir, name));
        if (info.isFile()) {
          entries.push({ path: `${directory}/${name}`, bytes: info.size });
        }
      }
      return entries;
    },
    async remove(path) {
      await rm(resolvePath(path), { force: true });
    },
  };
}

/** `storage.app-files` for headless hosts: the OS app data directory, via env-paths (ADR 0037). */
export default definePlugin({
  initialize(ctx) {
    const root = dataDirectory();
    ctx.logger.info({ root }, 'app files in data directory');
    ctx.capabilities.provide(storageAppFilesCapability, createNodeAppFiles(root));
  },
});
