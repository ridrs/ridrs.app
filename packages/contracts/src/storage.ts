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
  /** Resolves once what was appended to `path` is on the disk (ADR 0055). */
  sync(path: string): Promise<void>;
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
 * Large media on the device, such as downloaded video routes (docs/ideas/video-sources.md), apart
 * from the app files. Paths are relative and `/`-separated, checked like app file paths.
 */
export interface MediaFiles {
  /** Whether a file is there. */
  exists(path: string): Promise<boolean>;
  /** A small file, whole: never a video. */
  read(path: string): Promise<Uint8Array>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  /** Moves a file, creating the target's directories; replaces a file there. */
  move(from: string, to: string): Promise<void>;
  /** A file, or a directory with everything in it; a missing one is not an error. */
  remove(path: string): Promise<void>;
  /**
   * Where the file lies for providers on the same platform that write media themselves, such as
   * `data.fetch` and `data.archive`: an absolute path on the device.
   */
  location(path: string): string;
  /** A URL the UI can read the file from, by range for a video. */
  url(path: string): string;
}

export const storageMediaCapability = defineCapability<MediaFiles, 'single', 'storage.media'>(
  'storage.media',
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
