// SPDX-License-Identifier: AGPL-3.0-or-later

import { type AppFileEntry, type AppFiles, assertAppFilePath } from '@ridrs/contracts';

/** `storage.app-files` in memory: the files outlive the plugin, so a host can restart over them. */
export class MemoryAppFiles implements AppFiles {
  readonly files = new Map<string, Uint8Array>();
  /** While set, every append and write rejects. */
  failWrites = false;
  private readonly encoder = new TextEncoder();

  async append(path: string, text: string): Promise<void> {
    this.assertWritable(path);
    const previous = this.files.get(path) ?? new Uint8Array();
    const added = this.encoder.encode(text);
    const next = new Uint8Array(previous.length + added.length);
    next.set(previous);
    next.set(added, previous.length);
    this.files.set(path, next);
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    this.assertWritable(path);
    this.files.set(path, bytes.slice());
  }

  async replace(path: string, bytes: Uint8Array): Promise<void> {
    await this.write(path, bytes);
  }

  async read(path: string): Promise<Uint8Array> {
    const bytes = this.files.get(assertAppFilePath(path));
    if (!bytes) {
      throw new Error(`No such file "${path}"`);
    }
    return bytes.slice();
  }

  async list(directory: string): Promise<readonly AppFileEntry[]> {
    const prefix = `${assertAppFilePath(directory)}/`;
    return [...this.files]
      .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
      .map(([path, bytes]) => ({ path, bytes: bytes.length }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  async remove(path: string): Promise<void> {
    this.files.delete(assertAppFilePath(path));
  }

  private assertWritable(path: string): void {
    assertAppFilePath(path);
    if (this.failWrites) {
      throw new Error(`Writing "${path}" failed (simulated storage failure)`);
    }
  }
}
