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
  /**
   * Replaces the whole file atomically (ADR 0054): a temporary file, flushed to the disk and
   * renamed over the old one. After a crash the file is the old one or the new one.
   */
  replace(path: string, bytes: Uint8Array): Promise<void>;
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
 * Secrets such as access tokens, kept without asking the rider (ADR 0053). Keys are
 * dotted ids (`intervals-icu.token`); values are UTF-8 text. Secrets never go into events, logs,
 * recordings or app files.
 */
export interface Secrets {
  /** `undefined` when nothing is stored under `key`. */
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  /** Removing a missing key is not an error. */
  remove(key: string): Promise<void>;
}

export const storageSecretsCapability = defineCapability<Secrets, 'single', 'storage.secrets'>(
  'storage.secrets',
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
