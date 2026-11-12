// SPDX-License-Identifier: Apache-2.0

import { defineCapability } from './capabilities.ts';

/** A file to fetch into the media storage (`storage.media`). */
export interface DataFetchJob {
  readonly url: string;
  /** Media path of the finished file; until it is complete the data lies in `<target>.part`. */
  readonly target: string;
  /** What the source said about the file before, e.g. in a catalog; a different ETag starts over. */
  readonly expected?: { readonly size?: number; readonly etag?: string };
}

export interface DataFetchProgress {
  readonly received: number;
  /** Bytes in all, once known. */
  readonly size?: number;
}

/**
 * Large downloads that survive interruptions (docs/ideas/video-sources.md). The provider decides
 * how the bytes travel (Rust in the native app); it knows nothing about what they are. A partial
 * file goes on where it stopped while the source is unchanged.
 */
export interface DataFetch {
  /** Resolves once `target` is complete; rejects on a failure or when `signal` aborts, keeping the part. */
  fetch(
    job: DataFetchJob,
    onProgress?: (progress: DataFetchProgress) => void,
    signal?: AbortSignal,
  ): Promise<{ readonly size: number; readonly etag?: string }>;
}

export const dataFetchCapability = defineCapability<DataFetch, 'single', 'data.fetch'>(
  'data.fetch',
  {
    cardinality: 'single',
  },
);

/** Archives in the media storage, unpacked by a provider of the platform. */
export interface DataArchive {
  /** Unpacks every file of a ZIP into `directory` (media paths); resolves to the files' media paths. */
  extract(archive: string, directory: string): Promise<readonly string[]>;
}

export const dataArchiveCapability = defineCapability<DataArchive, 'single', 'data.archive'>(
  'data.archive',
  {
    cardinality: 'single',
  },
);

/** A file the rider chose, not yet in the media storage. */
export interface PickedFile {
  /** Its name with its extension, e.g. `Col de la Madone.zip`; never its place on the device. */
  readonly name: string;
  /** Bytes. */
  readonly size: number;
  /** Copies it to the media path `target`, creating its directories; once. */
  copyTo(target: string): Promise<void>;
}

/**
 * Files the rider brings into the media storage, chosen in the system's open dialog (ADR 0090).
 * The provider of the platform opens the dialog and copies; the caller never learns where the
 * file lies, and reads it only once it is a media file.
 */
export interface DataPick {
  /** Resolves once the dialog closed: the chosen file, or nothing when the rider cancelled. */
  pick(filter: {
    readonly name: string;
    readonly extensions: readonly string[];
  }): Promise<PickedFile | undefined>;
}

export const dataPickCapability = defineCapability<DataPick, 'single', 'data.pick'>('data.pick', {
  cardinality: 'single',
});
