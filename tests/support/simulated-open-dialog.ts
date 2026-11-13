// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DataPick } from '@ridrs/contracts';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { incyclistPackage } from './simulated-downloads.ts';
import { Holding, simulatedFile, withStoredVideo } from './simulated-file.ts';

/** A ZIP of a holiday video alone: no control file, no track. */
async function holidayPackage(): Promise<Uint8Array> {
  const zip = new ZipWriter(new Uint8ArrayWriter());
  await zip.add('holiday.mp4', new Uint8ArrayReader(new Uint8Array(64)));
  return zip.close();
}

/**
 * `data.pick` for the import scenarios: the system's open dialog, in which the rider chooses a
 * file or cancels. The chosen file is copied or unpacked into the media folder of the scenario.
 */
export class SimulatedOpenDialog {
  private choice: { readonly name: string; readonly bytes: () => Promise<Uint8Array> } | undefined;
  readonly filters: { readonly name: string; readonly extensions: readonly string[] }[] = [];
  /** Copying and unpacking the chosen file wait while held: the import stays on its way. */
  readonly holding = new Holding();

  constructor(private readonly mediaRoot: string) {}

  choose(name: string, kind: 'incyclist' | 'incyclist-stored' | 'no-control-file'): void {
    const packages = {
      incyclist: () => incyclistPackage(null),
      'incyclist-stored': async () => withStoredVideo(await incyclistPackage(null)),
      'no-control-file': holidayPackage,
    };
    this.choice = { name, bytes: packages[kind] };
  }

  cancel(): void {
    this.choice = undefined;
  }

  readonly pick: DataPick = {
    pick: async (filter) => {
      this.filters.push(filter);
      const choice = this.choice;
      if (!choice) return undefined;
      return simulatedFile(choice.name, await choice.bytes(), this.mediaRoot, this.holding);
    },
  };
}
