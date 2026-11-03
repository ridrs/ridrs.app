// SPDX-License-Identifier: Apache-2.0

import { defineCapability } from './capabilities.ts';
import { RidrsError } from './diagnostics.ts';

/**
 * Files in the app's data directory. Paths are relative and `/`-separated; the provider decides
 * where the root is (an OS app-data directory, the Tauri app container, memory in tests).
 */
export interface AppFiles {
  /** Appends UTF-8 text, creating the file (and its directories) if needed. */
  append(path: string, text: string): Promise<void>;
  /** Writes the whole file, creating or replacing it. */
  write(path: string, bytes: Uint8Array): Promise<void>;
  read(path: string): Promise<Uint8Array>;
  /** The files directly in `directory`, sorted by path; an absent directory is empty. */
  list(directory: string): Promise<readonly AppFileEntry[]>;
  remove(path: string): Promise<void>;
}

export interface AppFileEntry {
  /** Relative to the root, like the paths passed in. */
  readonly path: string;
  readonly bytes: number;
}

export const storageAppFilesCapability = defineCapability<AppFiles, 'single', 'storage.app-files'>(
  'storage.app-files',
  { cardinality: 'single' },
);

/**
 * Throws `invalid-path` unless `path` is relative, `/`-separated and free of `.`, `..` and empty
 * segments. Every provider checks paths with this before touching storage.
 */
export function assertAppFilePath(path: string): string {
  const segments = path.split('/');
  const valid =
    path.length > 0 &&
    !path.includes('\\') &&
    !/^[a-zA-Z]:/.test(path) &&
    segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
  if (!valid) {
    throw new RidrsError('invalid-path', `Invalid app file path "${path}"`);
  }
  return path;
}
