// SPDX-License-Identifier: AGPL-3.0-or-later

import { configure, Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js';

// The entries are workout files of a few kilobytes: no web workers (ADR 0065).
configure({ useWebWorkers: false });

export interface Entry {
  readonly fileName: string;
  readonly bytes: Uint8Array;
}

/** The files of a ZIP, folders and macOS resource forks left out. */
export async function unzip(bytes: Uint8Array): Promise<Entry[]> {
  const reader = new ZipReader(new Uint8ArrayReader(bytes));
  try {
    const entries: Entry[] = [];
    for (const entry of await reader.getEntries()) {
      const name = entry.filename;
      const base = name.slice(name.lastIndexOf('/') + 1);
      if (entry.directory || name.startsWith('__MACOSX/') || base.startsWith('.')) continue;
      entries.push({ fileName: name, bytes: await entry.getData(new Uint8ArrayWriter()) });
    }
    return entries;
  } finally {
    await reader.close();
  }
}
