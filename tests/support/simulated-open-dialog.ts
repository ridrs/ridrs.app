// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { DataPick } from '@ridrs/contracts';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { incyclistPackage } from './simulated-downloads.ts';

/** A ZIP of a holiday video alone: no control file, no track. */
async function holidayPackage(): Promise<Uint8Array> {
  const zip = new ZipWriter(new Uint8ArrayWriter());
  await zip.add('holiday.mp4', new Uint8ArrayReader(new Uint8Array(64)));
  return zip.close();
}

/**
 * `data.pick` for the import scenarios: the system's open dialog, in which the rider chooses a
 * file or cancels. The chosen file is copied into the media folder of the scenario.
 */
export class SimulatedOpenDialog {
  private choice: { readonly name: string; readonly bytes: () => Promise<Uint8Array> } | undefined;
  readonly filters: { readonly name: string; readonly extensions: readonly string[] }[] = [];

  /** While set, a copy waits until `goOn` is called: the import stays on its way. */
  private held: { promise: Promise<void>; release: () => void } | undefined;

  constructor(private readonly mediaRoot: string) {}

  /** Copies wait from now until `goOn`. */
  holdCopies(): void {
    let release = () => {};
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.held = { promise, release };
  }

  goOn(): void {
    this.held?.release();
    this.held = undefined;
  }

  choose(name: string, kind: 'incyclist' | 'no-control-file'): void {
    this.choice = { name, bytes: kind === 'incyclist' ? incyclistPackage : holidayPackage };
  }

  cancel(): void {
    this.choice = undefined;
  }

  readonly pick: DataPick = {
    pick: async (filter) => {
      this.filters.push(filter);
      const choice = this.choice;
      if (!choice) return undefined;
      const bytes = await choice.bytes();
      return {
        name: choice.name,
        size: bytes.length,
        copyTo: async (target) => {
          await this.held?.promise;
          const file = join(this.mediaRoot, ...target.split('/'));
          await mkdir(dirname(file), { recursive: true });
          await writeFile(file, bytes);
        },
      };
    },
  };
}
