// SPDX-License-Identifier: AGPL-3.0-or-later

import { access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { glob } from 'tinyglobby';
import type { PluginCandidate, PluginSource } from '../discovery.ts';

/** Discovery port adapter for Node hosts: every sub-folder of a plugin directory is a candidate. */
export function createFileSystemPluginSource(pluginsDir: string): PluginSource {
  const rootDir = resolve(pluginsDir);

  return {
    async list(): Promise<readonly PluginCandidate[]> {
      const [rawFolders, manifestMatches] = await Promise.all([
        glob('*', { cwd: rootDir, onlyDirectories: true }),
        glob('*/manifest.json', { cwd: rootDir }),
      ]);

      const foldersWithManifest = new Set(
        manifestMatches.map((m) => m.split('/')[0]).filter((f): f is string => Boolean(f)),
      );

      return rawFolders
        .map((f) => f.replace(/\/+$/, ''))
        .filter((f) => f.length > 0 && !f.includes('/'))
        .map((folder): PluginCandidate => {
          const folderPath = join(rootDir, folder);
          return {
            folder,
            location: folderPath,
            readManifest: async () =>
              foldersWithManifest.has(folder)
                ? readFile(join(folderPath, 'manifest.json'), 'utf8')
                : undefined,
            hasModule: async (relativePath) =>
              access(resolve(folderPath, relativePath)).then(
                () => true,
                () => false,
              ),
            loadModule: async (relativePath) =>
              import(pathToFileURL(resolve(folderPath, relativePath)).href),
          };
        });
    },
  };
}
