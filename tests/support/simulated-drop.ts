// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  type DataDrop,
  type DropEvent,
  type DroppedFile,
  type FilePeek,
  PEEK_EXTENSIONS,
  PEEK_LIMIT,
  type PeekedEntry,
} from '@ridrs/contracts';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from '@zip.js/zip.js';
import { incyclistPackage } from './simulated-downloads.ts';

/** The files a package can be made of in the scenarios. */
export type SimulatedPackage = 'incyclist' | 'video2gpx' | 'no-control-file';

/** video2gpx's packages add its own facts and a read-me to Incyclist's three files. */
async function video2gpxPackage(): Promise<Uint8Array> {
  const reader = new ZipReader(new Uint8ArrayReader(await incyclistPackage()));
  const zip = new ZipWriter(new Uint8ArrayWriter());
  for (const entry of await reader.getEntries()) {
    if (entry.directory) continue;
    await zip.add(
      entry.filename,
      new Uint8ArrayReader(await entry.getData(new Uint8ArrayWriter())),
    );
  }
  await reader.close();
  await zip.add('video2gpx.json', new Uint8ArrayReader(new TextEncoder().encode('{"version":1}')));
  await zip.add(
    'LIESMICH.txt',
    new Uint8ArrayReader(new TextEncoder().encode('Zum Fahren in Incyclist.')),
  );
  return zip.close();
}

/** A ZIP of a holiday video alone: no control file, no track. */
async function holidayPackage(): Promise<Uint8Array> {
  const zip = new ZipWriter(new Uint8ArrayWriter());
  await zip.add('holiday.mp4', new Uint8ArrayReader(new Uint8Array(64)));
  return zip.close();
}

const PACKAGES: Record<SimulatedPackage, () => Promise<Uint8Array>> = {
  incyclist: incyclistPackage,
  video2gpx: video2gpxPackage,
  'no-control-file': holidayPackage,
};

const extensionOf = (name: string) => name.slice(name.lastIndexOf('.') + 1).toLowerCase();
const peekable = (name: string) =>
  (PEEK_EXTENSIONS as readonly string[]).includes(extensionOf(name));

/** What the native provider reads of a file: a ZIP's entries, or a small file's bytes. */
async function peekInto(bytes: Uint8Array): Promise<FilePeek> {
  const reader = new ZipReader(new Uint8ArrayReader(bytes));
  try {
    const entries: PeekedEntry[] = [];
    for (const entry of await reader.getEntries()) {
      if (entry.directory) continue;
      const read = peekable(entry.filename) && entry.uncompressedSize <= PEEK_LIMIT;
      entries.push({
        name: entry.filename,
        size: entry.uncompressedSize,
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

/**
 * `data.drop` for the scenarios: the rider drags a file over the window, lets go of it or takes it
 * out again. A dropped file is copied into the media folder of the scenario.
 */
export class SimulatedDrop {
  private readonly listeners = new Set<(event: DropEvent) => void>();
  private files = new Map<string, DroppedFile>();
  private next = 0;

  constructor(private readonly mediaRoot: string) {}

  async drag(name: string, kind: SimulatedPackage): Promise<DroppedFile> {
    const bytes = await PACKAGES[kind]();
    this.next += 1;
    let copied = false;
    const file: DroppedFile = {
      id: `drop-${this.next}`,
      name,
      size: bytes.length,
      peek: () => peekInto(bytes),
      copyTo: async (target) => {
        if (copied) throw new Error(`"${name}" was copied already`);
        copied = true;
        const path = join(this.mediaRoot, ...target.split('/'));
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, bytes);
      },
    };
    this.files = new Map([[file.id, file]]);
    this.emit({ kind: 'enter', files: [file] });
    return file;
  }

  drop(): void {
    this.emit({ kind: 'drop', files: [...this.files.values()] });
  }

  leave(): void {
    this.files = new Map();
    this.emit({ kind: 'leave' });
  }

  private emit(event: DropEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  readonly provider: DataDrop = {
    subscribe: (listener) => {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    },
    file: (id) => this.files.get(id),
  };
}
