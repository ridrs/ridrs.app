// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  type DataFetchProgress,
  type FilePeek,
  PEEK_EXTENSIONS,
  PEEK_LIMIT,
  type PeekedEntry,
  type PickedFile,
} from '@ridrs/contracts';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from '@zip.js/zip.js';

const extensionOf = (name: string) => name.slice(name.lastIndexOf('.') + 1).toLowerCase();
const peekable = (name: string) =>
  (PEEK_EXTENSIONS as readonly string[]).includes(extensionOf(name));

/** What the native providers read of a file: a ZIP's entries, or a small file's bytes. */
export async function peekInto(bytes: Uint8Array): Promise<FilePeek> {
  const reader = new ZipReader(new Uint8ArrayReader(bytes));
  try {
    const entries: PeekedEntry[] = [];
    for (const entry of await reader.getEntries()) {
      if (entry.directory) continue;
      const read = peekable(entry.filename) && entry.uncompressedSize <= PEEK_LIMIT;
      entries.push({
        name: entry.filename,
        size: entry.uncompressedSize,
        stored: entry.compressionMethod === 0,
        ...(read ? { bytes: await entry.getData(new Uint8ArrayWriter()) } : {}),
      });
    }
    return { entries };
  } catch {
    return bytes.length <= PEEK_LIMIT ? { bytes } : {};
  } finally {
    await reader.close();
  }
}

/** The same package with its videos stored, not compressed: one ridrs plays from the ZIP. */
export async function withStoredVideo(bytes: Uint8Array): Promise<Uint8Array> {
  const reader = new ZipReader(new Uint8ArrayReader(bytes));
  const zip = new ZipWriter(new Uint8ArrayWriter());
  for (const entry of await reader.getEntries()) {
    if (entry.directory) continue;
    const data = new Uint8ArrayReader(await entry.getData(new Uint8ArrayWriter()));
    await zip.add(
      entry.filename,
      data,
      entry.filename.toLowerCase().endsWith('.mp4') ? { level: 0 } : {},
    );
  }
  await reader.close();
  return zip.close();
}

/**
 * Copying and unpacking a chosen or dragged file wait from `hold` until `goOn`: before they
 * start, or `halfway` with half of the bytes said to be done.
 */
export class Holding {
  private held: { promise: Promise<void>; release: () => void; halfway: boolean } | undefined;

  hold(halfway = false): void {
    let release = () => {};
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.held = { promise, release, halfway };
  }

  goOn(): void {
    this.held?.release();
    this.held = undefined;
  }

  async wait(size: number, onProgress?: (progress: DataFetchProgress) => void): Promise<void> {
    if (this.held?.halfway) onProgress?.({ received: Math.ceil(size / 2), size });
    await this.held?.promise;
  }
}

/**
 * A file the rider chose or dragged with these bytes, as the native providers give it: peeked
 * into, then copied into the media folder `mediaRoot` or unpacked there, once.
 */
export function simulatedFile(
  name: string,
  bytes: Uint8Array,
  mediaRoot: string,
  holding: Holding,
): Pick<PickedFile, 'name' | 'size' | 'peek' | 'copyTo' | 'extractTo'> {
  let used = false;
  const once = () => {
    if (used) throw new Error(`"${name}" was stored already`);
    used = true;
  };
  const write = async (target: string, data: Uint8Array) => {
    const path = join(mediaRoot, ...target.split('/'));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  };
  return {
    name,
    size: bytes.length,
    peek: () => peekInto(bytes),
    copyTo: async (target, onProgress) => {
      once();
      await holding.wait(bytes.length, onProgress);
      await write(target, bytes);
      onProgress?.({ received: bytes.length, size: bytes.length });
    },
    extractTo: async (directory, onProgress) => {
      once();
      const reader = new ZipReader(new Uint8ArrayReader(bytes));
      try {
        const entries = (await reader.getEntries()).filter((entry) => !entry.directory);
        const size = entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0);
        await holding.wait(size, onProgress);
        for (const entry of entries) {
          await write(
            `${directory}/${entry.filename}`,
            await entry.getData(new Uint8ArrayWriter()),
          );
        }
        onProgress?.({ received: size, size });
      } finally {
        await reader.close();
      }
    },
  };
}
