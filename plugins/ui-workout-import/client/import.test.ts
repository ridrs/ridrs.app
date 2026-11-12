// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyseWorkoutEntry } from '@ridrs/workout';
import { chooseId, planImport } from './plan.ts';

const FILES = resolve(import.meta.dirname, '../../../tests/fixtures/workout-import/files');
const bytes = (name: string) => new Uint8Array(readFileSync(resolve(FILES, name)));
const NOW = '2026-11-11T12:00:00.000Z';

describe('planImport', () => {
  it('derives ids that never collide and treats the same content as a duplicate', async () => {
    const [one] = await analyseWorkoutEntry({ fileName: 'over-unders.mrc', bytes: bytes('over-unders.mrc') }, NOW);
    expect(one?.kind).toBe('workout');
    if (one?.kind !== 'workout') return;
    const rows = [
      { key: 'a', analysis: one },
      { key: 'b', analysis: one },
    ];
    const first = planImport(rows, [{ id: 'over-unders', name: 'x' }], new Map());
    expect(first[0]?.id).toBe(`over-unders-${one.hash.slice(0, 8)}`);
    expect(first[1]).toMatchObject({ duplicateOf: 'over-unders', choice: 'skip' });
    expect(first[1]?.id).toBeUndefined();
    const copied = planImport(rows, [], new Map([['b', 'copy']]));
    expect(copied[0]?.id).toBe('over-unders');
    expect(copied[1]?.id).toBe(`over-unders-${one.hash.slice(0, 8)}`);
  });

  it('counts when even the hashed id is taken', () => {
    const taken = new Set(['a', 'a-12345678']);
    expect(chooseId('A', '12345678abcdef', taken, false)).toBe('a-12345678-2');
  });
});
