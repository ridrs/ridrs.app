// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, openAsBlob } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { MediaEntry } from '@ridrs/contracts';
import { BlobReader, configure, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js';

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
        return { path: entry.filename, size: entry.uncompressedSize, stored: entry.compressionMethod === 0 };
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

/**
 * The bytes of the entry a media path names below a route's folder where no file lies there: the
 * entry of the package in the nearest folder above it that has one (ADR 0094). `undefined` where
 * no folder above has a package or it has no such entry.
 */
export async function readPackageEntry(root: string, path: string): Promise<Uint8Array | undefined> {
  const segments = path.split('/');
  for (let depth = segments.length - 1; depth >= 1; depth -= 1) {
    const pack = join(root, ...segments.slice(0, depth), PACKAGE);
    if (!existsSync(pack)) continue;
    const name = segments.slice(depth).join('/').toLowerCase();
    const reader = new ZipReader(new BlobReader(await openAsBlob(pack)));
    try {
      const entry = (await reader.getEntries()).find(
        (candidate) => !candidate.directory && candidate.filename.toLowerCase() === name,
      );
      return entry && !entry.directory ? await entry.getData(new Uint8ArrayWriter()) : undefined;
    } finally {
      await reader.close();
    }
  }
  return undefined;
}
