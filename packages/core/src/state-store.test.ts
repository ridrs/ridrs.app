// SPDX-License-Identifier: AGPL-3.0-or-later

import { type Diagnostic, defineState, RidrsError, type StateView } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { StateStore } from './state-store.ts';

const offerState = defineState(
  'test.offer',
  z.object({ title: z.string(), progress: z.number().min(0).max(1).optional() }).strict(),
);

/** Lets every queued microtask run, the store's flushes among them. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup() {
  const diagnostics: Diagnostic[] = [];
  const store = new StateStore({ report: (d) => diagnostics.push(d) });
  store.register([offerState]);
  const views: StateView<unknown>[] = [];
  const watch = (owner = 'watcher') =>
    store.watch(owner, offerState.id, (view) => views.push(view));
  return { store, diagnostics, views, watch };
}

function codeOf(run: () => void): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof RidrsError ? error.code : `not a RidrsError: ${String(error)}`;
  }
  return undefined;
}

describe('StateStore', () => {
  it('delivers the snapshot first, then only the changed keys', async () => {
    const { store, views, watch } = setup();
    store.set('owner', offerState.id, 'a', { title: 'A' });
    store.set('owner', offerState.id, 'b', { title: 'B' });
    watch();
    await flush();
    expect(views).toHaveLength(1);
    expect(views[0]?.changed).toEqual(['a', 'b']);
    expect([...(views[0]?.entries.keys() ?? [])]).toEqual(['a', 'b']);

    store.set('owner', offerState.id, 'b', { title: 'B', progress: 0.5 });
    await flush();
    expect(views).toHaveLength(2);
    expect(views[1]?.changed).toEqual(['b']);
    expect(views[1]?.entries.get('b')).toEqual({ title: 'B', progress: 0.5 });
  });

  it('delivers an empty snapshot for a topic without entries', async () => {
    const { views, watch } = setup();
    watch();
    await flush();
    expect(views).toHaveLength(1);
    expect(views[0]?.changed).toEqual([]);
    expect(views[0]?.entries.size).toBe(0);
  });

  it('coalesces writes of one tick into one delivery with the last value', async () => {
    const { store, views, watch } = setup();
    watch();
    await flush();
    for (let i = 1; i <= 10; i += 1) {
      store.set('owner', offerState.id, 'a', { title: 'A', progress: i / 10 });
    }
    await flush();
    expect(views).toHaveLength(2);
    expect(views[1]?.changed).toEqual(['a']);
    expect(views[1]?.entries.get('a')).toEqual({ title: 'A', progress: 1 });
  });

  it('gives a key to its first writer', () => {
    const { store } = setup();
    store.set('first', offerState.id, 'a', { title: 'A' });
    store.set('first', offerState.id, 'a', { title: 'A again' });
    expect(codeOf(() => store.set('second', offerState.id, 'a', { title: 'mine' }))).toBe(
      'state-key-owned',
    );
    expect(() => store.set('second', offerState.id, 'a', { title: 'mine' })).toThrow(
      /"first".*"second"|"second".*"first"/,
    );
    expect(store.get(offerState.id, 'a')).toEqual({ title: 'A again' });
    expect(store.ownerOf(offerState.id, 'a')).toBe('first');
  });

  it('lets only the owner remove a key, and a missing key is no error', () => {
    const { store } = setup();
    store.set('first', offerState.id, 'a', { title: 'A' });
    expect(codeOf(() => store.remove('second', offerState.id, 'a'))).toBe('state-key-owned');
    store.remove('first', offerState.id, 'missing');
    store.remove('first', offerState.id, 'a');
    expect(store.get(offerState.id, 'a')).toBeUndefined();
    store.set('second', offerState.id, 'a', { title: 'now mine' });
    expect(store.ownerOf(offerState.id, 'a')).toBe('second');
  });

  it('refuses an invalid value and names its path', () => {
    const { store } = setup();
    let error: unknown;
    try {
      store.set('owner', offerState.id, 'a', { title: 'A', progress: 2 } as never);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RidrsError);
    expect((error as RidrsError).code).toBe('invalid-state-value');
    expect((error as RidrsError).message).toContain('progress');
    expect(store.get(offerState.id, 'a')).toBeUndefined();
  });

  it('refuses a topic nobody registered', () => {
    const { store } = setup();
    expect(codeOf(() => store.set('owner', 'test.unknown', 'a', {}))).toBe('unknown-state');
    expect(codeOf(() => store.watch('owner', 'test.unknown', () => {}))).toBe('unknown-state');
  });

  it("removes a released plugin's keys and ends its watches", async () => {
    const { store, views, watch } = setup();
    const theirs: StateView<unknown>[] = [];
    store.watch('owner', offerState.id, (view) => theirs.push(view));
    watch();
    store.set('owner', offerState.id, 'a', { title: 'A' });
    store.set('other', offerState.id, 'b', { title: 'B' });
    await flush();
    store.releasePlugin('owner');
    await flush();
    expect(views.at(-1)?.changed).toEqual(['a']);
    expect([...(views.at(-1)?.entries.keys() ?? [])]).toEqual(['b']);
    expect(theirs).toHaveLength(1);
  });

  it('delivers writes made during a delivery in the next flush and reports feedback once', async () => {
    const { store, diagnostics, views } = setup();
    let round = 0;
    store.watch('looper', offerState.id, (view) => {
      views.push(view);
      if (round < 3) {
        round += 1;
        store.set('looper', offerState.id, 'a', { title: `round ${round}` });
      }
    });
    await flush();
    await flush();
    expect(views.map((v) => v.entries.get('a'))).toEqual([
      undefined,
      { title: 'round 1' },
      { title: 'round 2' },
      { title: 'round 3' },
    ]);
    expect(diagnostics.filter((d) => d.code === 'state-feedback')).toHaveLength(1);
  });

  it('tells observers every write as it happens, with its owner', () => {
    const { store } = setup();
    const seen: unknown[] = [];
    const observation = store.observe('test', (topic, key, value, owner) =>
      seen.push([topic, key, value, owner]),
    );
    store.set('owner', offerState.id, 'a', { title: 'A' });
    store.remove('owner', offerState.id, 'a');
    observation.unsubscribe();
    store.set('owner', offerState.id, 'b', { title: 'B' });
    expect(seen).toEqual([
      ['test.offer', 'a', { title: 'A' }, 'owner'],
      ['test.offer', 'a', undefined, 'owner'],
    ]);
  });

  it('takes 1000 writes of an offer-sized value in under 50 ms', () => {
    const sized = defineState(
      'test.sized',
      z
        .object({
          id: z.string(),
          title: z.string(),
          profile: z.array(z.object({ distance: z.number(), elevation: z.number() })),
          progress: z.number(),
        })
        .strict(),
    );
    const store = new StateStore({ report: () => {} });
    store.register([sized]);
    store.watch('watcher', sized.id, () => {});
    const profile = Array.from({ length: 64 }, (_, i) => ({ distance: i * 100, elevation: i }));
    const started = performance.now();
    for (let i = 0; i < 1000; i += 1) {
      store.set('owner', sized.id, 'route', { id: 'route', title: 'Col', profile, progress: i });
    }
    expect(performance.now() - started).toBeLessThan(50);
  });
});
