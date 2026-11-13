// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  assertAppFilePath,
  type DataDrop,
  type DataFetchProgress,
  type DropEvent,
  type DroppedFile,
  type FilePeek,
  type PeekedEntry,
} from '@ridrs/contracts';

/** Tauri's `invoke`, or a stand-in in the tests. */
export type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/** Tauri's `Channel` for the progress of a copy from Rust, or a stand-in in the tests. */
export type ProgressChannel = (onProgress?: (progress: DataFetchProgress) => void) => unknown;

/** A file of the drag, as `media_drop_files` names it. */
interface Dragged {
  readonly token: string;
  readonly name: string;
  readonly size: number;
}

/** What `media_drop_peek` finds; `media_drop_read` gives the bytes of what is readable. */
interface Peeked {
  readonly entries: readonly { readonly name: string; readonly size: number; readonly readable: boolean }[] | null;
  readonly readable: boolean;
}

/** Dispatched on the window by Rust when a drag session over it ends (ADR 0093). */
const DRAG_ENDED = 'ridrs:drag-ended';

const carriesFiles = (event: Event) => [...((event as DragEvent).dataTransfer?.types ?? [])].includes('Files');

/**
 * Watches the drags of files over `target` (the window) and tells `data.drop` of them. The page
 * learns nothing of a hovering file, so the files come from Rust whenever a drag enters an element
 * and again when it is let go (the same drag keeps its files, and is told of once);
 * `dragenter` and `dragleave` of the elements inside are counted, so the drag leaves once it left
 * the window, or once Rust tells that the drag session ended without a drop (Escape). The app's
 * own drags carry no files and pass by. The calls to Rust run one after another, in the order of the events.
 */
export function watchDrags(
  target: EventTarget,
  invoke: Invoke,
  channel: ProgressChannel,
  failed: (error: unknown) => void,
): { readonly drop: DataDrop; stop(): void } {
  const listeners = new Set<(event: DropEvent) => void>();
  let files = new Map<string, DroppedFile>();
  let depth = 0;
  let calls: Promise<void> = Promise.resolve();

  const emit = (event: DropEvent) => {
    for (const listener of listeners) listener(event);
  };
  const then = (work: () => Promise<void>) => {
    calls = calls.then(work).catch(failed);
  };

  const read = async (token: string, entry?: string) =>
    new Uint8Array(await invoke<ArrayBuffer>('media_drop_read', { token, entry: entry ?? null }));

  const peek = async (token: string): Promise<FilePeek> => {
    const peeked = await invoke<Peeked>('media_drop_peek', { token });
    if (peeked.entries) {
      const entries: PeekedEntry[] = [];
      for (const { name, size, readable } of peeked.entries) {
        entries.push(readable ? { name, size, bytes: await read(token, name) } : { name, size });
      }
      return { entries };
    }
    return peeked.readable ? { bytes: await read(token) } : {};
  };

  const fileOf = ({ token, name, size }: Dragged): DroppedFile => ({
    id: `drop-${token}`,
    name,
    size,
    peek: () => peek(token),
    copyTo: (path, onProgress) =>
      invoke<void>('media_pick_copy', { token, target: assertAppFilePath(path), onProgress: channel(onProgress) }),
    removeOriginal: () => invoke<void>('media_drop_remove', { token }),
  });

  /**
   * The files of the drag from Rust; a file it named before stays the same object. `dropped`: they
   * were let go, and Rust keeps where they lie for their removal after a move.
   */
  const sync = async (dropped = false): Promise<DroppedFile[]> => {
    const dragged = await invoke<Dragged[]>('media_drop_files', { dropped });
    files = new Map(dragged.map((file) => [`drop-${file.token}`, files.get(`drop-${file.token}`) ?? fileOf(file)]));
    return [...files.values()];
  };

  /** The ids of the files last told of: a new drag is told of even if a leave went missing. */
  let told = '';
  const onEnter = (event: Event) => {
    if (!carriesFiles(event)) return;
    depth += 1;
    then(async () => {
      const entered = await sync();
      const ids = entered.map((file) => file.id).join('\n');
      if (entered.length === 0 || ids === told) return;
      told = ids;
      emit({ kind: 'enter', files: entered });
    });
  };
  const leave = () => {
    depth = 0;
    then(async () => {
      files = new Map();
      told = '';
      await invoke<void>('media_drop_leave');
      emit({ kind: 'leave' });
    });
  };
  const onLeave = (event: Event) => {
    if (!carriesFiles(event) || depth === 0) return;
    depth -= 1;
    if (depth === 0) leave();
  };
  /**
   * The drag session ended (Rust tells of it, `media_drop::tell_ended_drags`): one that was not
   * let go and still counts as inside left without a `dragleave`, as Escape ends one on macOS.
   */
  const onEnded = () => {
    if (depth > 0) leave();
  };
  const onDrop = (event: Event) => {
    if (!carriesFiles(event)) return;
    depth = 0;
    then(async () => {
      const dropped = await sync(true);
      told = '';
      if (dropped.length > 0) emit({ kind: 'drop', files: dropped });
    });
  };

  target.addEventListener('dragenter', onEnter, true);
  target.addEventListener('dragleave', onLeave, true);
  target.addEventListener('drop', onDrop, true);
  target.addEventListener(DRAG_ENDED, onEnded);

  return {
    drop: {
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      file: (id) => files.get(id),
    },
    stop() {
      target.removeEventListener('dragenter', onEnter, true);
      target.removeEventListener('dragleave', onLeave, true);
      target.removeEventListener('drop', onDrop, true);
      target.removeEventListener(DRAG_ENDED, onEnded);
      listeners.clear();
    },
  };
}
