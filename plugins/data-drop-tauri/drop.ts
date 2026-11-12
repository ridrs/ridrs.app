// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  assertAppFilePath,
  type DataDrop,
  type DropEvent,
  type DroppedFile,
  type FilePeek,
  type PeekedEntry,
} from '@ridrs/contracts';

/** Tauri's `invoke`, or a stand-in in the tests. */
export type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

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

const carriesFiles = (event: Event) => [...((event as DragEvent).dataTransfer?.types ?? [])].includes('Files');

/**
 * Watches the drags of files over `target` (the window) and tells `data.drop` of them. The page
 * learns nothing of a hovering file, so the files come from Rust when a drag enters and again
 * when it is let go (the same drag keeps its files); `dragenter` and `dragleave` of the elements
 * inside are counted, so the drag leaves once it left the window. The app's own drags carry no
 * files and pass by. The calls to Rust run one after another, in the order of the events.
 */
export function watchDrags(
  target: EventTarget,
  invoke: Invoke,
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
    copyTo: (path) => invoke<void>('media_pick_copy', { token, target: assertAppFilePath(path) }),
  });

  /** The files of the drag from Rust; a file it named before stays the same object. */
  const sync = async (): Promise<DroppedFile[]> => {
    const dragged = await invoke<Dragged[]>('media_drop_files');
    files = new Map(dragged.map((file) => [`drop-${file.token}`, files.get(`drop-${file.token}`) ?? fileOf(file)]));
    return [...files.values()];
  };

  const onEnter = (event: Event) => {
    if (!carriesFiles(event)) return;
    depth += 1;
    if (depth !== 1) return;
    then(async () => {
      const entered = await sync();
      if (entered.length > 0) emit({ kind: 'enter', files: entered });
    });
  };
  const onLeave = (event: Event) => {
    if (!carriesFiles(event) || depth === 0) return;
    depth -= 1;
    if (depth !== 0) return;
    then(async () => {
      files = new Map();
      await invoke<void>('media_drop_leave');
      emit({ kind: 'leave' });
    });
  };
  const onDrop = (event: Event) => {
    if (!carriesFiles(event)) return;
    depth = 0;
    then(async () => {
      const dropped = await sync();
      if (dropped.length > 0) emit({ kind: 'drop', files: dropped });
    });
  };

  target.addEventListener('dragenter', onEnter, true);
  target.addEventListener('dragleave', onLeave, true);
  target.addEventListener('drop', onDrop, true);

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
      listeners.clear();
    },
  };
}
