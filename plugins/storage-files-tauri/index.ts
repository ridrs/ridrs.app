// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type AppFileEntry,
  type AppFiles,
  assertAppFilePath,
  definePlugin,
  storageAppFilesCapability,
} from '@ridrs/contracts';
import { invoke } from '@tauri-apps/api/core';
import {
  BaseDirectory,
  exists,
  mkdir,
  readDir,
  readFile,
  remove,
  stat,
  writeFile,
  writeTextFile,
} from '@tauri-apps/plugin-fs';

const baseDir = BaseDirectory.AppData;

async function withDirectory(path: string): Promise<string> {
  const directory = path.slice(0, path.lastIndexOf('/'));
  if (directory && !(await exists(directory, { baseDir }))) {
    await mkdir(directory, { baseDir, recursive: true });
  }
  return path;
}

/**
 * `storage.app-files` in the native app: the app container's data directory through the official
 * Tauri fs plugin (ADR 0038), scoped to `$APPDATA/{recordings,training,config}/**`; replacing
 * and flushing go through the app's `app_file_*` commands.
 */
export const tauriAppFiles: AppFiles = {
  async append(path, text) {
    await writeTextFile(await withDirectory(assertAppFilePath(path)), text, { baseDir, append: true });
  },
  async write(path, bytes) {
    await writeFile(await withDirectory(assertAppFilePath(path)), bytes, { baseDir });
  },
  async replace(path, bytes) {
    // The fs plugin cannot flush: the app command writes, flushes and renames (ADR 0054).
    await invoke('app_file_replace', { path: assertAppFilePath(path), bytes: [...bytes] });
  },
  async sync(path) {
    await invoke('app_file_sync', { path: assertAppFilePath(path) });
  },
  async read(path) {
    return readFile(assertAppFilePath(path), { baseDir });
  },
  async list(directory) {
    if (!(await exists(assertAppFilePath(directory), { baseDir }))) {
      return [];
    }
    const entries: AppFileEntry[] = [];
    for (const entry of await readDir(directory, { baseDir })) {
      if (entry.isFile) {
        const path = `${directory}/${entry.name}`;
        entries.push({ path, bytes: (await stat(path, { baseDir })).size });
      }
    }
    return entries.sort((a, b) => a.path.localeCompare(b.path));
  },
  async remove(path) {
    await remove(assertAppFilePath(path), { baseDir });
  },
};

export default definePlugin({
  initialize(ctx) {
    ctx.capabilities.provide(storageAppFilesCapability, tauriAppFiles);
  },
});
