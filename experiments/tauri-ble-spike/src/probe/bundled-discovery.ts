// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Probe: bundled plugin discovery with Vite's `import.meta.glob`, as proposed in
 * `prompts/tech-stack-ui-and-bluetooth.md` §5.2. Measures what works; it is not the Phase 3 port.
 *
 * Globs are static (resolved at build time) and relative to this file. Negative patterns exclude
 * Node-only plugins; manifests are read eagerly as raw strings so the manifest stays authoritative
 * and is validated with the same schema as filesystem discovery.
 */

import { type PluginDefinition, type PluginManifest, parseManifestJson } from '@ridrs/contracts';

const manifestSources = import.meta.glob<string>(
  ['../../../../plugins/*/manifest.json', '!../../../../plugins/transport-ble-noble/**', '!../../../../plugins/output-console/**'],
  { query: '?raw', import: 'default', eager: true },
);

const entryModules = import.meta.glob<{ default: PluginDefinition }>([
  '../../../../plugins/*/index.ts',
  '!../../../../plugins/transport-ble-noble/**',
  '!../../../../plugins/output-console/**',
]);

export interface BundledPlugin {
  readonly folder: string;
  readonly manifest: PluginManifest;
  load(): Promise<PluginDefinition>;
}

export interface BundledDiscoveryResult {
  readonly plugins: BundledPlugin[];
  readonly problems: string[];
}

export function discoverBundledPlugins(): BundledDiscoveryResult {
  const plugins: BundledPlugin[] = [];
  const problems: string[] = [];
  for (const [manifestPath, raw] of Object.entries(manifestSources).sort(([a], [b]) => a.localeCompare(b))) {
    const folderPath = manifestPath.slice(0, -'/manifest.json'.length);
    const folder = folderPath.split('/').at(-1) ?? folderPath;
    const parsed = parseManifestJson(raw);
    if (!parsed.success) {
      problems.push(`invalid-manifest ${folder}: ${parsed.message}`);
      continue;
    }
    const entryKey = `${folderPath}/${parsed.data.entry.replace(/^\.\//, '')}`;
    const loader = entryModules[entryKey];
    if (!loader) {
      problems.push(`entry-not-bundled ${folder}: ${entryKey}`);
      continue;
    }
    plugins.push({ folder, manifest: parsed.data, load: async () => (await loader()).default });
  }
  return { plugins, problems };
}
