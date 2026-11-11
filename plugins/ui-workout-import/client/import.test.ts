// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyse, analyseText, notesOf } from './analyse.ts';
import { detectFormat } from './formats.ts';
import { chooseId, planImport } from './plan.ts';

const FILES = resolve(import.meta.dirname, '../../../tests/fixtures/workout-import/files');
const bytes = (name: string) => new Uint8Array(readFileSync(resolve(FILES, name)));
const NOW = '2026-11-11T12:00:00.000Z';

describe('detectFormat', () => {
  it('takes the extension first and the content when the name says nothing', () => {
    expect(detectFormat('a.zwo', new Uint8Array([1]))).toBe('zwo');
    expect(detectFormat('workout', bytes('sweet-spot-3x12.zwo'))).toBe('zwo');
    expect(detectFormat('workout', bytes('watts-3x10.fit'))).toBe('fit');
    expect(detectFormat('workout', bytes('threshold-2x10.erg'))).toBe('erg');
    expect(detectFormat('workout', bytes('over-unders.mrc'))).toBe('mrc');
    expect(detectFormat('workout', bytes('run-only.tcx'))).toBe('tcx');
    expect(detectFormat('x.bin', bytes('three-workouts.zip'))).toBe('zip');
    expect(detectFormat('notes', new TextEncoder().encode('hello'))).toBeUndefined();
  });
});

describe('analyse', () => {
  it('reads a watts FIT and explains it', async () => {
    const [result] = await analyse({ fileName: 'watts-3x10.fit', bytes: bytes('watts-3x10.fit') }, NOW);
    expect(result?.kind).toBe('workout');
    if (result?.kind !== 'workout') return;
    expect(result.state).toBe('ok');
    expect(result.notes).toEqual([{ kind: 'units', units: ['watts'] }]);
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.workout.source.originalHash).toBe(result.hash);
  });

  it('refuses a running workout and a broken file with their codes', async () => {
    const [run] = await analyse({ fileName: 'run-only.tcx', bytes: bytes('run-only.tcx') }, NOW);
    expect(run).toMatchObject({ kind: 'error', diagnostics: [{ code: 'not-cycling' }] });
    const [broken] = await analyse({ fileName: 'b.zwo', bytes: bytes('broken-unclosed.zwo') }, NOW);
    expect(broken).toMatchObject({ kind: 'error', diagnostics: [{ code: 'invalid-xml' }] });
  });

  it('refuses an empty and an unknown file', async () => {
    const [empty] = await analyse({ fileName: 'a.zwo', bytes: new Uint8Array() }, NOW);
    expect(empty).toMatchObject({ kind: 'error', diagnostics: [{ code: 'empty-file' }] });
    const [unknown] = await analyse({ fileName: 'a.bin', bytes: new Uint8Array([1, 2, 3]) }, NOW);
    expect(unknown).toMatchObject({ kind: 'error', diagnostics: [{ code: 'unknown-format' }] });
  });

  it('counts the steps by heart rate and RPE of a pasted text', async () => {
    const text = new TextDecoder().decode(bytes('zones-and-heart-rate.txt'));
    const [result] = await analyseText(text, 'Mix', NOW);
    expect(result?.kind).toBe('workout');
    if (result?.kind !== 'workout') return;
    expect(result.workout.name).toBe('Mix');
    expect(notesOf(result.workout)).toContainEqual({ kind: 'no-erg', reason: 'heart-rate', count: 5 });
    expect(notesOf(result.workout)).toContainEqual({ kind: 'no-erg', reason: 'rpe', count: 1 });
    expect(result.state).toBe('warning');
  });
});

describe('planImport', () => {
  it('derives ids that never collide and treats the same content as a duplicate', async () => {
    const [one] = await analyse({ fileName: 'over-unders.mrc', bytes: bytes('over-unders.mrc') }, NOW);
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
