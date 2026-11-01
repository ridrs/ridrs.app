// SPDX-License-Identifier: AGPL-3.0-or-later

import type { PluginCandidate, PluginSource } from './discovery.ts';

/**
 * A plugin set fixed at build time, in the shape `import.meta.glob` produces: raw manifest JSON and
 * lazy module loaders, both keyed by path. Keys may be relative (`../../plugins/x/manifest.json`).
 */
export interface BundledPluginSet {
  readonly manifests: Readonly<Record<string, string>>;
  readonly modules: Readonly<Record<string, () => Promise<unknown>>>;
}

// A deep fake base lets URL resolution normalize `./` and `../` segments of relative glob keys.
const NORMALIZE_BASE = 'bundle:/_/_/_/_/';

function normalizeKey(key: string): string {
  return new URL(key, NORMALIZE_BASE).pathname;
}

/** Discovery port adapter for apps: plugins come from the bundle, never from a file system. */
export function createBundledPluginSource(set: BundledPluginSet): PluginSource {
  const modules = new Map(
    Object.entries(set.modules).map(([key, load]) => [normalizeKey(key), load] as const),
  );

  return {
    async list(): Promise<readonly PluginCandidate[]> {
      return Object.entries(set.manifests).map(([key, rawJson]) => {
        const manifestPath = normalizeKey(key);
        const folderPath = manifestPath.slice(0, manifestPath.lastIndexOf('/') + 1);
        const folder = folderPath.split('/').at(-2) ?? folderPath;
        const resolveModule = (relativePath: string) =>
          new URL(relativePath, `bundle:${folderPath}`).pathname;

        return {
          folder,
          location: `bundle:${folderPath}`,
          readManifest: async () => rawJson,
          hasModule: async (relativePath) => modules.has(resolveModule(relativePath)),
          loadModule: async (relativePath) => {
            const load = modules.get(resolveModule(relativePath));
            if (!load) {
              throw new Error(`Module "${relativePath}" of folder "${folder}" is not bundled`);
            }
            return load();
          },
        };
      });
    },
  };
}
