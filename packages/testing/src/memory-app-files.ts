// SPDX-License-Identifier: AGPL-3.0-or-later

import { type AppFileEntry, type AppFiles, assertAppFilePath } from '@ridrs/contracts';

/** `storage.app-files` in memory: the files outlive the plugin, so a host can restart over them. */
export class MemoryAppFiles implements AppFiles {
  readonly files = new Map<string, Uint8Array>();
  /** While set, every append and write rejects. */
  failWrites = false;
  /** How many bytes of each file are on the "disk": appended bytes count once synced. */
  private readonly synced = new Map<string, number>();
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
    // Whole files count as on the disk at once: only appends wait for a sync.
    this.synced.set(path, bytes.length);
  }

  async replace(path: string, bytes: Uint8Array): Promise<void> {
    await this.write(path, bytes);
  }

  async sync(path: string): Promise<void> {
    this.assertWritable(path);
    const bytes = this.files.get(path);
    if (bytes) {
      this.synced.set(path, bytes.length);
    }
  }

  /**
   * A power loss: every file keeps only what was on the disk, an appended file never synced is
   * gone, and nothing is written until `powerRestored`.
   */
  losePower(): void {
    for (const [path, bytes] of [...this.files]) {
      const kept = this.synced.get(path);
      if (kept === undefined) {
        this.files.delete(path);
      } else {
        this.files.set(path, bytes.slice(0, kept));
      }
    }
    this.failWrites = true;
  }

  powerRestored(): void {
    this.failWrites = false;
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
    this.synced.delete(path);
  }

  private assertWritable(path: string): void {
    assertAppFilePath(path);
    if (this.failWrites) {
      throw new Error(`Writing "${path}" failed (simulated storage failure)`);
    }
  }
}
