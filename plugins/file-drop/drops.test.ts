// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DroppedFile, FileDrop, FilePeek, RouteImportPreview, Workout } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import { type DropServices, FileDrops, type KnownWorkout } from './drops.ts';

const FILES = resolve(import.meta.dirname, '../../tests/fixtures/workout-import/files');
const fixture = (name: string) => new Uint8Array(readFileSync(resolve(FILES, name)));

function dropped(id: string, name: string, peek: FilePeek): DroppedFile {
  return { id, name, size: 1, peek: async () => peek, copyTo: async () => {} };
}

const ROUTE: RouteImportPreview = {
  ok: true,
  preview: { kind: 'video', title: 'Col de Test', distance: 300, ascent: 12, sparkline: [1, 2] },
};

function setup(options: { known?: KnownWorkout[]; preview?: RouteImportPreview } = {}) {
  const states: (FileDrop | undefined)[] = [];
  const saved: { workout: Workout; original: { fileName: string; data: string } }[] = [];
  const routes: string[] = [];
  const services: DropServices = {
    routeProviders: () => ['video-source-local'],
    knownWorkouts: () => options.known ?? [],
    preview: async () => options.preview ?? { ok: false, reason: 'The package has no control file' },
    importRoute: async (provider, file) => {
      routes.push(`${provider}:${file}`);
    },
    saveWorkout: async (workout, original) => {
      saved.push({ workout, original });
      return true;
    },
    now: () => '2026-11-12T12:00:00.000Z',
  };
  const drops = new FileDrops(services, (state) => states.push(state));
  return { drops, states, saved, routes, last: () => states.at(-1) };
}

describe('FileDrops', () => {
  it('reads a workout file, shows it, and saves it with its original once it is let go', async () => {
    const { drops, saved, last } = setup();
    drops.enter([dropped('drop-1', 'threshold-2x10.erg', { bytes: fixture('threshold-2x10.erg') })]);
    expect(last()?.files[0]?.verdict).toEqual({ kind: 'reading' });
    await drops.read();
    const over = last();
    expect(over?.phase).toBe('over');
    const verdict = over?.files[0]?.verdict;
    expect(verdict?.kind === 'workouts' && verdict.workouts.map((w) => [w.workout.name, w.state])).toEqual([
      ['Threshold 2x10', 'ok'],
    ]);

    await drops.import();
    expect(saved.map(({ workout }) => workout.id)).toEqual(['threshold-2x10']);
    expect(saved[0]?.workout.source.originalHash).toMatch(/^[0-9a-f]{64}$/);
    expect(saved[0]?.original.fileName).toBe('threshold-2x10.erg');
    expect(atob(saved[0]?.original.data ?? '')).toContain('[COURSE HEADER]');
    expect(last()).toMatchObject({ phase: 'done', saved: 1, skipped: 0, routes: 0, failed: 0 });

    // The same drag is added once.
    await drops.import();
    expect(saved).toHaveLength(1);
  });

  it('leaves out a workout the library has, and gives a copy of a taken id its hash', async () => {
    const first = setup();
    first.drops.enter([dropped('drop-1', 'a.erg', { bytes: fixture('threshold-2x10.erg') })]);
    await first.drops.import();
    const hash = first.saved[0]?.workout.source.originalHash ?? '';

    const again = setup({ known: [{ id: 'threshold-2x10', name: 'Threshold 2x10', originalHash: hash }] });
    again.drops.enter([dropped('drop-2', 'a.erg', { bytes: fixture('threshold-2x10.erg') })]);
    await again.drops.read();
    const verdict = again.last()?.files[0]?.verdict;
    expect(verdict?.kind === 'workouts' && verdict.workouts[0]?.state).toBe('duplicate');
    await again.drops.import();
    expect(again.saved).toEqual([]);
    expect(again.last()).toMatchObject({ phase: 'done', saved: 0, skipped: 1 });

    const other = setup({ known: [{ id: 'threshold-2x10', name: 'Someone else' }] });
    other.drops.enter([dropped('drop-3', 'threshold-2x10.erg', { bytes: fixture('threshold-2x10.erg') })]);
    await other.drops.import();
    expect(other.saved[0]?.workout.id).toBe(`threshold-2x10-${hash.slice(0, 8)}`);
  });

  it('shows a workout dragged twice at once as one to add', async () => {
    const { drops, saved, last } = setup();
    drops.enter([
      dropped('drop-1', 'threshold-2x10.erg', { bytes: fixture('threshold-2x10.erg') }),
      dropped('drop-2', 'more.zip', { entries: [{ name: 'threshold-2x10.erg', size: 1, bytes: fixture('threshold-2x10.erg') }] }),
    ]);
    await drops.read();
    const states = last()?.files.map((file) => file.verdict.kind === 'workouts' && file.verdict.workouts[0]?.state);
    expect(states).toEqual(['ok', 'duplicate']);
    await drops.import();
    expect(saved).toHaveLength(1);
    expect(last()).toMatchObject({ saved: 1, skipped: 1 });
  });

  it('takes every workout of a ZIP', async () => {
    const { drops, saved } = setup();
    const entries = ['intervals-free-max.zwo', 'threshold-2x10.erg', 'over-unders.mrc'].map((name) => ({
      name,
      size: 1,
      bytes: fixture(name),
    }));
    drops.enter([dropped('drop-1', 'three.zip', { entries: [...entries, { name: 'big.mp4', size: 9 }] })]);
    await drops.import();
    expect(saved).toHaveLength(3);
  });

  it('takes a package a provider previews as a route, whatever workouts it holds', async () => {
    const { drops, routes, last } = setup({ preview: ROUTE });
    const readMe = { name: 'LIESMICH.txt', size: 5, bytes: new TextEncoder().encode('4x 10m 90%') };
    drops.enter([dropped('drop-1', 'Col_de_Test.ride', { entries: [readMe] })]);
    await drops.read();
    expect(last()?.files[0]?.verdict).toEqual({ kind: 'route', provider: 'video-source-local', preview: ROUTE.preview });
    await drops.import();
    expect(routes).toEqual(['video-source-local:drop-1']);
    expect(last()).toMatchObject({ phase: 'done', routes: 1, saved: 0 });
  });

  it('refuses a .ride without a route, a picture and a video, with the reason', async () => {
    const { drops, last } = setup();
    drops.enter([
      dropped('drop-1', 'Holiday.ride', { entries: [{ name: 'holiday.mp4', size: 64 }] }),
      dropped('drop-2', 'Holiday.jpg', { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }),
      dropped('drop-3', 'Holiday.mp4', {}),
    ]);
    await drops.read();
    expect(last()?.files.map((file) => file.verdict)).toEqual([
      { kind: 'refused', reason: 'The package has no control file' },
      { kind: 'refused', reason: 'ridrs cannot import Holiday.jpg' },
      { kind: 'refused', reason: 'ridrs cannot import Holiday.mp4' },
    ]);
  });

  it('forgets a drag that left the window: nothing to import', async () => {
    const { drops, saved, last } = setup();
    drops.enter([dropped('drop-1', 'a.erg', { bytes: fixture('threshold-2x10.erg') })]);
    drops.leave();
    expect(last()).toBeUndefined();
    await drops.import();
    expect(saved).toEqual([]);
    expect(last()).toBeUndefined();
  });
});
