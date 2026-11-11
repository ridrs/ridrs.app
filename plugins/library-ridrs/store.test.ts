// SPDX-License-Identifier: AGPL-3.0-or-later

import { type AppFiles, type Workout, workoutSchema } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import { sha256Hex, WorkoutStore } from './store.ts';

const workout = (id: string, extra: Partial<Workout['source']> = {}): Workout =>
  workoutSchema.parse({
    format: 'ridrs-workout',
    version: 1,
    id,
    name: id,
    sport: 'ride',
    source: { kind: 'imported', ...extra },
    steps: [
      {
        kind: 'interval',
        id: '1',
        duration: { kind: 'time', seconds: 60 },
        effort: { kind: 'target', primary: { unit: 'watts', start: { low: 200, high: 200 } } },
      },
    ],
  });

/** The files in a map; the store uses write, replace, read, list and remove only. */
class MemoryAppFiles implements AppFiles {
  async append() {}
  async sync() {}
  readonly files = new Map<string, Uint8Array>();
  async write(path: string, data: Uint8Array) {
    this.files.set(path, data);
  }
  replace = this.write;
  async read(path: string) {
    const data = this.files.get(path);
    if (!data) throw new Error(`No file ${path}`);
    return data;
  }
  async list(directory: string) {
    return [...this.files]
      .filter(([path]) => path.startsWith(`${directory}/`))
      .map(([path, data]) => ({ path, bytes: data.length }));
  }
  async remove(path: string) {
    this.files.delete(path);
  }
}

const bytes = new TextEncoder().encode('original file');
const original = { fileName: 'a.zwo', data: Buffer.from(bytes).toString('base64') };

describe('WorkoutStore', () => {
  it('keeps a workout and its original and reads them back', async () => {
    const files = new MemoryAppFiles();
    const store = new WorkoutStore(files, () => {});
    const saved = await store.save(workout('a'), original);
    const hash = await sha256Hex(bytes);
    expect(saved.source.originalHash).toBe(hash);
    expect(files.files.has(`training/originals/${hash}`)).toBe(true);
    const again = new WorkoutStore(files, () => {});
    await again.load();
    expect(again.workouts.get('a')?.source.originalHash).toBe(hash);
  });

  it('refuses an original that does not match the named hash', async () => {
    const store = new WorkoutStore(new MemoryAppFiles(), () => {});
    await expect(store.save(workout('a', { originalHash: 'f'.repeat(64) }), original)).rejects.toMatchObject({
      code: 'invalid-request',
    });
    expect(store.workouts.size).toBe(0);
  });

  it('skips a file that is not a workout and says so', async () => {
    const files = new MemoryAppFiles();
    await files.write('training/workouts/bad.json', new TextEncoder().encode('{"nope":1}'));
    const warnings: string[] = [];
    const store = new WorkoutStore(files, (message) => warnings.push(message));
    await store.load();
    expect(store.workouts.size).toBe(0);
    expect(warnings).toHaveLength(1);
  });

  it('keeps ids with odd characters in a safe file name', async () => {
    const files = new MemoryAppFiles();
    await new WorkoutStore(files, () => {}).save(workout('../x y/é'), undefined);
    expect([...files.files.keys()]).toEqual(['training/workouts/..%2Fx%20y%2F%C3%A9.json']);
  });
});
