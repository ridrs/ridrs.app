// SPDX-License-Identifier: AGPL-3.0-or-later

import { type PluginManifest, parseManifestJson } from '@ridrs/contracts';
import type { DiagnosticCollector } from './diagnostics.ts';

/**
 * One plugin folder as a plugin source sees it. How folders are found, manifests read and modules
 * loaded is the source's business (file system, bundle); validation stays in the core.
 */
export interface PluginCandidate {
  readonly folder: string;
  /** Human-readable location for logs and diagnostics only. */
  readonly location: string;
  /** Raw manifest JSON, or `undefined` when the folder has no manifest. Throws when unreadable. */
  readManifest(): Promise<string | undefined>;
  /** Whether a file relative to the plugin folder is available to load. */
  hasModule(relativePath: string): Promise<boolean>;
  /** Loads an ES module relative to the plugin folder. */
  loadModule(relativePath: string): Promise<unknown>;
}

/** Discovery port: lists the plugin folders a host can see. */
export interface PluginSource {
  list(): Promise<readonly PluginCandidate[]>;
}

export interface DiscoveredPlugin {
  readonly folder: string;
  readonly location: string;
  readonly manifest: Readonly<PluginManifest>;
  readonly candidate: PluginCandidate;
}

export async function discoverPlugins(
  sources: readonly PluginSource[],
  diagnostics: DiagnosticCollector,
): Promise<DiscoveredPlugin[]> {
  const candidates: DiscoveredPlugin[] = [];

  for (const source of sources) {
    const listed = [...(await source.list())].sort((a, b) => a.folder.localeCompare(b.folder));

    for (const candidate of listed) {
      const { folder } = candidate;
      let rawJson: string | undefined;
      try {
        rawJson = await candidate.readManifest();
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        diagnostics.report({
          code: 'missing-manifest',
          folder,
          message: `Could not read manifest.json in folder "${folder}": ${reason}`,
        });
        continue;
      }

      if (rawJson === undefined) {
        diagnostics.report({
          code: 'missing-manifest',
          folder,
          message: `Plugin folder "${folder}" is missing a manifest.json file`,
        });
        continue;
      }

      const validation = parseManifestJson(rawJson);
      if (!validation.success) {
        diagnostics.report({
          code: 'invalid-manifest',
          folder,
          message: `Invalid manifest in folder "${folder}": ${validation.message}`,
        });
        continue;
      }

      const manifest = Object.freeze({
        ...validation.data,
        types: [...validation.data.types],
        provides: [...validation.data.provides],
        requires: [...validation.data.requires],
      });

      candidates.push({ folder, location: candidate.location, manifest, candidate });
    }
  }

  const byId = new Map<string, DiscoveredPlugin[]>();
  for (const candidate of candidates) {
    const existing = byId.get(candidate.manifest.id);
    if (existing) {
      existing.push(candidate);
    } else {
      byId.set(candidate.manifest.id, [candidate]);
    }
  }

  const validPlugins: DiscoveredPlugin[] = [];
  for (const [pluginId, group] of byId.entries()) {
    if (group.length > 1) {
      const duplicateFolders = group.map((g) => g.folder).sort((a, b) => a.localeCompare(b));
      diagnostics.report({
        code: 'duplicate-id',
        pluginId,
        message: `Duplicate plugin id "${pluginId}" found in folders: ${duplicateFolders.join(', ')}`,
        details: { folders: duplicateFolders },
      });
      continue;
    }
    const single = group[0];
    if (single) {
      validPlugins.push(single);
    }
  }

  return validPlugins.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
}
