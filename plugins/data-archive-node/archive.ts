// SPDX-License-Identifier: AGPL-3.0-or-later

import { type FileHandle, mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { assertAppFilePath, type DataArchive, type MediaFiles } from '@ridrs/contracts';
import { configure, Reader, Writer, ZipReader } from '@zip.js/zip.js';

configure({ useWebWorkers: false });

/** A file on disk for zip.js, read by range: the central directory and one entry at a time. */
class FileRangeReader extends Reader<string> {
  private handle: FileHandle | undefined;

  override async init(): Promise<void> {
    this.handle = await open(this.path, 'r');
    this.size = (await this.handle.stat()).size;
  }

  constructor(private readonly path: string) {
    super(path);
  }

  override async readUint8Array(index: number, length: number): Promise<Uint8Array> {
    const bytes = new Uint8Array(length);
    const { bytesRead } = await (this.handle as FileHandle).read(bytes, 0, length, index);
    return bytes.subarray(0, bytesRead);
  }

  async close(): Promise<void> {
    await this.handle?.close();
  }
}

/**
 * A file on disk that zip.js writes an entry into, chunk by chunk. A zip.js writer, not a web
 * stream: zip.js tells streams by the global `WritableStream`, which a test DOM may replace.
 */
class FileWriter extends Writer<void> {
  private handle: FileHandle | undefined;

  constructor(private readonly path: string) {
    super();
  }

  override async init(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    this.handle = await open(this.path, 'w');
    await super.init?.();
  }

  override async writeUint8Array(array: Uint8Array): Promise<void> {
    await (this.handle as FileHandle).write(array);
  }

  override async getData(): Promise<void> {
    await this.handle?.close();
  }
}

/**
 * `data.archive` on the device's disk (ADR 0065): every file of a ZIP streamed into the folder,
 * ZIP64 included. A name that would leave the folder fails the whole extraction.
 */
export function createNodeArchive(media: MediaFiles): DataArchive {
  return {
    async extract(archive, directory, onProgress) {
      const file = new FileRangeReader(media.location(archive));
      const zip = new ZipReader(file);
      try {
        const extracted: string[] = [];
        const files = (await zip.getEntries()).filter((entry) => !entry.directory);
        const size = files.reduce((sum, entry) => sum + entry.uncompressedSize, 0);
        let done = 0;
        for (const entry of files) {
          const path = assertAppFilePath(`${directory}/${entry.filename}`);
          await entry.getData(new FileWriter(media.location(path)), {
            onprogress: async (received) => onProgress?.({ received: done + received, size }),
          });
          done += entry.uncompressedSize;
          onProgress?.({ received: done, size });
          extracted.push(path);
        }
        return extracted;
      } finally {
        await zip.close();
        await file.close();
      }
    },
  };
}
