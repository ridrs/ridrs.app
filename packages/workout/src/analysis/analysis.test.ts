// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  analyseWorkoutEntry,
  analyseWorkoutFile,
  analyseWorkoutText,
  workoutNotes,
} from './analyse.ts';
import { detectWorkoutFormat } from './formats.ts';

const FILES = resolve(import.meta.dirname, '../../../../tests/fixtures/workout-import/files');
const bytes = (name: string) => new Uint8Array(readFileSync(resolve(FILES, name)));
const NOW = '2026-11-11T12:00:00.000Z';

describe('detectWorkoutFormat', () => {
  it('takes the extension first and the content when the name says nothing', () => {
    expect(detectWorkoutFormat('a.zwo', new Uint8Array([1]))).toBe('zwo');
    expect(detectWorkoutFormat('workout', bytes('sweet-spot-3x12.zwo'))).toBe('zwo');
    expect(detectWorkoutFormat('workout', bytes('watts-3x10.fit'))).toBe('fit');
    expect(detectWorkoutFormat('workout', bytes('threshold-2x10.erg'))).toBe('erg');
    expect(detectWorkoutFormat('workout', bytes('over-unders.mrc'))).toBe('mrc');
    expect(detectWorkoutFormat('workout', bytes('run-only.tcx'))).toBe('tcx');
    expect(detectWorkoutFormat('x.bin', bytes('three-workouts.zip'))).toBe('zip');
    expect(detectWorkoutFormat('notes', new TextEncoder().encode('hello'))).toBeUndefined();
  });
});

describe('analyseWorkoutEntry', () => {
  it('reads a watts FIT and explains it', async () => {
    const [result] = await analyseWorkoutEntry(
      { fileName: 'watts-3x10.fit', bytes: bytes('watts-3x10.fit') },
      NOW,
    );
    expect(result?.kind).toBe('workout');
    if (result?.kind !== 'workout') return;
    expect(result.state).toBe('ok');
    expect(result.notes).toEqual([{ kind: 'units', units: ['watts'] }]);
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.workout.source.originalHash).toBe(result.hash);
  });

  it('refuses a running workout and a broken file with their codes', async () => {
    const [run] = await analyseWorkoutEntry(
      { fileName: 'run-only.tcx', bytes: bytes('run-only.tcx') },
      NOW,
    );
    expect(run).toMatchObject({ kind: 'error', diagnostics: [{ code: 'not-cycling' }] });
    const [broken] = await analyseWorkoutEntry(
      { fileName: 'b.zwo', bytes: bytes('broken-unclosed.zwo') },
      NOW,
    );
    expect(broken).toMatchObject({ kind: 'error', diagnostics: [{ code: 'invalid-xml' }] });
  });

  it('refuses an empty and an unknown file', async () => {
    const [empty] = await analyseWorkoutEntry({ fileName: 'a.zwo', bytes: new Uint8Array() }, NOW);
    expect(empty).toMatchObject({ kind: 'error', diagnostics: [{ code: 'empty-file' }] });
    const [unknown] = await analyseWorkoutEntry(
      { fileName: 'a.bin', bytes: new Uint8Array([1, 2, 3]) },
      NOW,
    );
    expect(unknown).toMatchObject({ kind: 'error', diagnostics: [{ code: 'unknown-format' }] });
  });

  it('counts the steps by heart rate and RPE of a pasted text', async () => {
    const text = new TextDecoder().decode(bytes('zones-and-heart-rate.txt'));
    const [result] = await analyseWorkoutText(text, 'Mix', NOW);
    expect(result?.kind).toBe('workout');
    if (result?.kind !== 'workout') return;
    expect(result.workout.name).toBe('Mix');
    expect(workoutNotes(result.workout)).toContainEqual({
      kind: 'no-erg',
      reason: 'heart-rate',
      count: 5,
    });
    expect(workoutNotes(result.workout)).toContainEqual({
      kind: 'no-erg',
      reason: 'rpe',
      count: 1,
    });
    expect(result.state).toBe('warning');
  });
});

describe('analyseWorkoutFile', () => {
  it('reads every workout of a ZIP and refuses a ZIP it cannot read', async () => {
    const results = await analyseWorkoutFile(
      { fileName: 'three.zip', bytes: bytes('three-workouts.zip') },
      NOW,
    );
    expect(results).toHaveLength(3);
    expect(results.every((result) => result.kind === 'workout')).toBe(true);
    const [bad] = await analyseWorkoutFile(
      { fileName: 'bad.zip', bytes: new Uint8Array([0x50, 0x4b, 3, 4, 0]) },
      NOW,
    );
    expect(bad).toMatchObject({ kind: 'error', diagnostics: [{ code: 'bad-zip' }] });
  });
});
