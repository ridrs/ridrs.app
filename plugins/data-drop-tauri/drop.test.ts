// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import type { DropEvent } from '@ridrs/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Invoke, watchDrags } from './drop.ts';

/** Rust's side: the files of the drag by token, and every call made. */
class FakeRust {
  dragged = [{ token: '1', name: 'Col_de_Test.ride', size: 15_000_000_000 }];
  readonly calls: { command: string; args?: Record<string, unknown> }[] = [];

  readonly invoke: Invoke = async <T>(command: string, args?: Record<string, unknown>) => {
    this.calls.push(args === undefined ? { command } : { command, args });
    switch (command) {
      case 'media_drop_files':
        return this.dragged as T;
      case 'media_drop_peek':
        return {
          entries: [
            { name: 'Col.xml', size: 3, readable: true },
            { name: 'Col.mp4', size: 15_000_000_000, readable: false },
          ],
          readable: false,
        } as T;
      case 'media_drop_read':
        return new TextEncoder().encode(`bytes of ${String(args?.entry)}`).buffer as T;
      default:
        return undefined as T;
    }
  };

  commands(): string[] {
    return this.calls.map((call) => call.command);
  }
}

// happy-dom has no DataTransfer: a drag event carries what WebKit gives while a file hovers.
function drag(type: string, types: readonly string[] = ['Files']): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { types } });
  return event;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('watchDrags', () => {
  let rust: FakeRust;
  let inner: HTMLElement;
  let events: DropEvent[];
  let errors: unknown[];
  let stops: (() => void)[] = [];

  afterEach(() => {
    for (const stop of stops) stop();
    stops = [];
  });

  beforeEach(() => {
    rust = new FakeRust();
    document.body.replaceChildren();
    inner = document.body.appendChild(document.createElement('div'));
    events = [];
    errors = [];
  });

  const watch = () => {
    const watched = watchDrags(window, rust.invoke, (error) => errors.push(error));
    stops.push(watched.stop);
    watched.drop.subscribe((event) => events.push(event));
    return watched;
  };

  it('tells of the files of a drag when it enters, and the same files when it is let go', async () => {
    const { drop } = watch();
    document.body.dispatchEvent(drag('dragenter'));
    // Moving onto an element inside is no new drag.
    inner.dispatchEvent(drag('dragenter'));
    document.body.dispatchEvent(drag('dragleave'));
    await settle();
    expect(events.map((event) => event.kind)).toEqual(['enter']);
    const [entered] = events;
    expect(entered?.kind === 'enter' && entered.files.map(({ id, name, size }) => ({ id, name, size }))).toEqual([
      { id: 'drop-1', name: 'Col_de_Test.ride', size: 15_000_000_000 },
    ]);

    inner.dispatchEvent(drag('drop'));
    await settle();
    expect(events.map((event) => event.kind)).toEqual(['enter', 'drop']);
    const [, dropped] = events;
    expect(dropped?.kind === 'drop' && entered?.kind === 'enter' && dropped.files[0]).toBe(
      entered?.kind === 'enter' && entered.files[0],
    );
    expect(drop.file('drop-1')?.name).toBe('Col_de_Test.ride');
    expect(rust.commands()).toEqual(['media_drop_files', 'media_drop_files', 'media_drop_files']);
    expect(errors).toEqual([]);
  });

  it('forgets the files when the drag leaves the window', async () => {
    const { drop } = watch();
    document.body.dispatchEvent(drag('dragenter'));
    inner.dispatchEvent(drag('dragenter'));
    document.body.dispatchEvent(drag('dragleave'));
    inner.dispatchEvent(drag('dragleave'));
    await settle();
    expect(events.map((event) => event.kind)).toEqual(['enter', 'leave']);
    expect(rust.commands()).toEqual(['media_drop_files', 'media_drop_files', 'media_drop_leave']);
    expect(drop.file('drop-1')).toBeUndefined();
  });

  it('tells of a new drag even when the leave of the last one went missing', async () => {
    watch();
    document.body.dispatchEvent(drag('dragenter'));
    await settle();
    rust.dragged = [{ token: '2', name: 'b.zwo', size: 9 }];
    inner.dispatchEvent(drag('dragenter'));
    await settle();
    expect(events.map((event) => event.kind === 'enter' && event.files[0]?.id)).toEqual(['drop-1', 'drop-2']);
  });

  it('leaves the app’s own drags alone', async () => {
    watch();
    document.body.dispatchEvent(drag('dragenter', ['text/plain']));
    document.body.dispatchEvent(drag('drop', ['text/plain']));
    await settle();
    expect(events).toEqual([]);
    expect(rust.calls).toEqual([]);
  });

  it('tells of nothing where Rust can read no drag', async () => {
    rust.dragged = [];
    watch();
    document.body.dispatchEvent(drag('dragenter'));
    document.body.dispatchEvent(drag('drop'));
    await settle();
    expect(events).toEqual([]);
  });

  it('peeks into a package and copies the file through its token', async () => {
    const { drop } = watch();
    document.body.dispatchEvent(drag('dragenter'));
    await settle();
    const file = drop.file('drop-1');
    expect(await file?.peek()).toEqual({
      entries: [
        { name: 'Col.xml', size: 3, bytes: new TextEncoder().encode('bytes of Col.xml') },
        { name: 'Col.mp4', size: 15_000_000_000 },
      ],
    });
    await file?.copyTo('videos/video-source-local/col.zip');
    expect(rust.calls.at(-1)).toEqual({
      command: 'media_pick_copy',
      args: { token: '1', target: 'videos/video-source-local/col.zip' },
    });
  });

  it('stops watching', async () => {
    const watched = watch();
    watched.stop();
    document.body.dispatchEvent(drag('dragenter'));
    await settle();
    expect(rust.calls).toEqual([]);
  });
});
