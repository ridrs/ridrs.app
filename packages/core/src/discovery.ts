// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { type PluginManifest, parseManifestJson } from '@ridrs/contracts';
import { glob } from 'tinyglobby';
import type { DiagnosticCollector } from './diagnostics.ts';

export interface DiscoveredPlugin {
  readonly folder: string;
  readonly folderPath: string;
  readonly entryPath: string;
  readonly manifest: Readonly<PluginManifest>;
}

export async function discoverPlugins(
  pluginsDir: string,
  diagnostics: DiagnosticCollector,
): Promise<DiscoveredPlugin[]> {
  const rootDir = resolve(pluginsDir);

  const [rawFolders, manifestMatches] = await Promise.all([
    glob('*', { cwd: rootDir, onlyDirectories: true }),
    glob('*/manifest.json', { cwd: rootDir }),
  ]);

  const folders = rawFolders
    .map((f) => f.replace(/\/+$/, ''))
    .filter((f) => f.length > 0 && !f.includes('/'))
    .sort((a, b) => a.localeCompare(b));

  const foldersWithManifest = new Set(
    manifestMatches.map((m) => m.split('/')[0]).filter((f): f is string => Boolean(f)),
  );

  const candidates: DiscoveredPlugin[] = [];

  for (const folder of folders) {
    if (!foldersWithManifest.has(folder)) {
      diagnostics.report({
        code: 'missing-manifest',
        folder,
        message: `Plugin folder "${folder}" is missing a manifest.json file`,
      });
      continue;
    }

    const folderPath = join(rootDir, folder);
    const manifestPath = join(folderPath, 'manifest.json');

    let rawJson: string;
    try {
      rawJson = await readFile(manifestPath, 'utf8');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      diagnostics.report({
        code: 'missing-manifest',
        folder,
        message: `Could not read manifest.json in folder "${folder}": ${reason}`,
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

    candidates.push({
      folder,
      folderPath,
      entryPath: resolve(folderPath, manifest.entry),
      manifest,
    });
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
