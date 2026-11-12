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

/** Bytes a peek reads of one file or of one entry of a ZIP, at most. */
export const PEEK_LIMIT = 8 * 1024 * 1024;

/** The entries of a ZIP whose bytes a peek reads: control files, tracks and workouts. */
export const PEEK_EXTENSIONS = [
  'xml',
  'gpx',
  'json',
  'zwo',
  'fit',
  'erg',
  'mrc',
  'tcx',
  'txt',
  'md',
] as const;

/** One entry of a dropped ZIP. */
export interface PeekedEntry {
  /** Its path inside the ZIP, e.g. `FR_Test.gpx`. */
  readonly name: string;
  /** Bytes, unpacked. */
  readonly size: number;
  /** Its bytes, for an entry of {@link PEEK_EXTENSIONS} up to {@link PEEK_LIMIT}. */
  readonly bytes?: Uint8Array;
}

/** What a preview may read of a dropped file before it is copied (ADR 0093). */
export interface FilePeek {
  /** The file's bytes, when it is no ZIP and at most {@link PEEK_LIMIT}. */
  readonly bytes?: Uint8Array;
  /** Its entries, when it is a ZIP; a ZIP that cannot be read has none. */
  readonly entries?: readonly PeekedEntry[];
}

/** A file dragged onto the window: a {@link PickedFile} that a preview can peek into. */
export interface DroppedFile extends PickedFile {
  /** Unique while the app runs. */
  readonly id: string;
  peek(): Promise<FilePeek>;
}

/** Files dragged over the window, let go on it, or taken out of it again. */
export type DropEvent =
  | { readonly kind: 'enter'; readonly files: readonly DroppedFile[] }
  | { readonly kind: 'drop'; readonly files: readonly DroppedFile[] }
  | { readonly kind: 'leave' };

/**
 * Files the rider drags onto the window (ADR 0093). The provider of the platform reads what is
 * dragged while it hovers and keeps where the files lie to itself, as `data.pick` does; a file
 * is good for one copy and for the drag it came with and the drop that follows it.
 */
export interface DataDrop {
  /** Tells `listener` of every drag from now on; returns its end. */
  subscribe(listener: (event: DropEvent) => void): () => void;
  /** A file of the drag on its way or of the last drop; nothing once it is gone. */
  file(id: string): DroppedFile | undefined;
}

export const dataDropCapability = defineCapability<DataDrop, 'single', 'data.drop'>('data.drop', {
  cardinality: 'single',
});
