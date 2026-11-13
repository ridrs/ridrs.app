// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, openAsBlob } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { MediaEntry } from '@ridrs/contracts';
import { BlobReader, configure, ZipReader } from '@zip.js/zip.js';

configure({ useWebWorkers: false });

/** A route's package in its folder (ADR 0094); never an entry itself. */
export const PACKAGE = 'route.ride';

/** The files below `dir`, their paths relative to the route's folder; not the package, nothing hidden. */
async function filesBelow(dir: string, prefix: string): Promise<MediaEntry[]> {
  const files: MediaEntry[] = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    if (item.name.startsWith('.') || (prefix === '' && item.name === PACKAGE)) continue;
    const path = `${prefix}${item.name}`;
    if (item.isDirectory()) files.push(...(await filesBelow(join(dir, item.name), `${path}/`)));
    else if (item.isFile()) files.push({ path, size: (await stat(join(dir, item.name))).size });
  }
  return files;
}

/** The files of the package, read from its central directory; a name leaving the folder refuses it. */
async function packageEntries(file: string): Promise<MediaEntry[]> {
  const reader = new ZipReader(new BlobReader(await openAsBlob(file)));
  try {
    return (await reader.getEntries())
      .filter((entry) => !entry.directory)
      .map((entry) => {
        const segments = entry.filename.split('/');
        if (entry.filename.startsWith('/') || entry.filename.includes('\\') || segments.some((s) => s === '..' || s === '.' || s === '')) {
          throw new Error(`${PACKAGE}: unsafe name "${entry.filename}"`);
        }
        return { path: entry.filename, size: entry.uncompressedSize };
      });
  } finally {
    await reader.close();
  }
}

/**
 * The entries of the route in the folder `dir` (ADR 0094), as `crates/ridrs-media/src/ride.rs`
 * lists them: the package's in its order, each replaced by a file of its path (letters compared
 * without case), then the other files in the order of their paths. A missing folder has none.
 */
export async function routeEntries(dir: string): Promise<MediaEntry[]> {
  if (!existsSync(dir)) return [];
  const files = (await filesBelow(dir, '')).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const pack = join(dir, PACKAGE);
  const entries = existsSync(pack) ? await packageEntries(pack) : [];
  for (const file of files) {
    const at = entries.findIndex((entry) => entry.path.toLowerCase() === file.path.toLowerCase());
    if (at >= 0) entries[at] = file;
    else entries.push(file);
  }
  return entries;
}
