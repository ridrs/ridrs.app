// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Workout, WorkoutStep } from '@ridrs/contracts';
import {
  isHeartRateUnit,
  isPowerUnit,
  validateWorkout,
  type WorkoutDiagnostic,
} from '@ridrs/workout';
import { detectFormat, IMPORTERS } from './formats.ts';
import { type Entry, unzip } from './zip.ts';

/** What a rider should know about an imported workout, apart from the importer's diagnostics. */
export type Note =
  /** The units of the power targets: what is ridden how. Nothing is converted. */
  | { readonly kind: 'units'; readonly units: readonly ('watts' | 'percent-ftp' | 'power-zone')[] }
  /** Steps ERG cannot hold, by the reason. */
  | { readonly kind: 'no-erg'; readonly reason: NoErgReason; readonly count: number }
  | { readonly kind: 'diagnostic'; readonly diagnostic: WorkoutDiagnostic };

export type NoErgReason = 'heart-rate' | 'speed' | 'rpe' | 'free' | 'max-effort';

/** The result for one workout of a file, or for a file that gave none. */
export type Analysis =
  | {
      readonly kind: 'workout';
      readonly fileName: string;
      readonly hash: string;
      /** The bytes of the file, kept as the original. */
      readonly bytes: Uint8Array;
      readonly workout: Workout;
      readonly notes: readonly Note[];
      readonly state: 'ok' | 'warning';
    }
  | {
      readonly kind: 'error';
      readonly fileName: string;
      readonly diagnostics: readonly WorkoutDiagnostic[];
    };

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

const fail = (fileName: string, code: string, message: string): Analysis => ({
  kind: 'error',
  fileName,
  diagnostics: [{ severity: 'error', code, message }],
});

function intervals(steps: readonly WorkoutStep[]): Extract<WorkoutStep, { kind: 'interval' }>[] {
  return steps.flatMap((step) => (step.kind === 'repeat' ? intervals(step.steps) : [step]));
}

/** The notes that explain a workout: its power units, and the steps ERG cannot ride. */
export function notesOf(workout: Workout): Note[] {
  const units = new Set<'watts' | 'percent-ftp' | 'power-zone'>();
  const counts = new Map<NoErgReason, number>();
  const count = (reason: NoErgReason) => counts.set(reason, (counts.get(reason) ?? 0) + 1);
  for (const step of intervals(workout.steps)) {
    if (step.effort.kind === 'free') count('free');
    else if (step.effort.kind === 'max-effort') count('max-effort');
    else {
      const unit = step.effort.primary.unit;
      if (isPowerUnit(unit)) units.add(unit as 'watts' | 'percent-ftp' | 'power-zone');
      else if (isHeartRateUnit(unit)) count('heart-rate');
      else count(unit === 'rpe' ? 'rpe' : 'speed');
    }
  }
  const notes: Note[] = [];
  if (units.size > 0) {
    notes.push({
      kind: 'units',
      units: (['watts', 'percent-ftp', 'power-zone'] as const).filter((unit) => units.has(unit)),
    });
  }
  for (const [reason, n] of counts) notes.push({ kind: 'no-erg', reason, count: n });
  return notes;
}

/**
 * Reads one file with the importer of its format. A ZIP is not read here (`expand` unpacks it).
 * `importedAt` comes from the caller's clock.
 */
export async function analyse(entry: Entry, importedAt: string): Promise<Analysis[]> {
  const { fileName, bytes } = entry;
  if (bytes.length === 0) return [fail(fileName, 'empty-file', 'The file is empty')];
  const format = detectFormat(fileName, bytes);
  if (format === undefined || format === 'zip') {
    return [fail(fileName, 'unknown-format', 'ridrs cannot tell which workout format the file has')];
  }
  const hash = await sha256Hex(bytes);
  let result: ReturnType<(typeof IMPORTERS)[typeof format]>;
  try {
    result = IMPORTERS[format](bytes, { fileName, originalHash: hash, importedAt });
  } catch (error) {
    return [fail(fileName, 'import-failed', String(error))];
  }
  if (!result.ok) return [{ kind: 'error', fileName, diagnostics: result.diagnostics }];
  if (result.workouts.length === 0) {
    return [{ kind: 'error', fileName, diagnostics: result.diagnostics }];
  }
  return result.workouts.map((workout): Analysis => {
    const problems = validateWorkout(workout);
    if (problems.length > 0) return { kind: 'error', fileName, diagnostics: problems };
    const notes: Note[] = [
      ...notesOf(workout),
      ...result.diagnostics.map((diagnostic): Note => ({ kind: 'diagnostic', diagnostic })),
    ];
    const state =
      result.diagnostics.some((d) => d.severity === 'warning') || notes.some((n) => n.kind === 'no-erg')
        ? 'warning'
        : 'ok';
    return { kind: 'workout', fileName, hash, bytes, workout, notes, state };
  });
}

/** A text pasted from an intervals.icu description, as the workout `name`. */
export async function analyseText(text: string, name: string, importedAt: string): Promise<Analysis[]> {
  const bytes = new TextEncoder().encode(text);
  const fileName = `${name.trim() || 'workout'}.txt`;
  const hash = await sha256Hex(bytes);
  const result = IMPORTERS.intervals(text, { fileName, originalHash: hash, importedAt });
  if (!result.ok || result.workouts.length === 0) {
    return [{ kind: 'error', fileName, diagnostics: result.diagnostics }];
  }
  return result.workouts.map((imported): Analysis => {
    const workout: Workout = {
      ...imported,
      id: name.trim() || imported.id,
      name: name.trim() || imported.name,
      source: { ...imported.source, fileName },
    };
    const notes: Note[] = [
      ...notesOf(workout),
      ...result.diagnostics.map((diagnostic): Note => ({ kind: 'diagnostic', diagnostic })),
    ];
    const state =
      result.diagnostics.some((d) => d.severity === 'warning') || notes.some((n) => n.kind === 'no-erg')
        ? 'warning'
        : 'ok';
    return { kind: 'workout', fileName, hash, bytes, workout, notes, state };
  });
}

/** A file, or every file of a ZIP, read; a ZIP that cannot be read is one error. */
export async function analyseFile(entry: Entry, importedAt: string): Promise<Analysis[]> {
  if (detectFormat(entry.fileName, entry.bytes) !== 'zip') return analyse(entry, importedAt);
  let entries: Entry[];
  try {
    entries = await unzip(entry.bytes);
  } catch {
    return [fail(entry.fileName, 'bad-zip', 'The ZIP file cannot be read')];
  }
  if (entries.length === 0) return [fail(entry.fileName, 'empty-zip', 'The ZIP file holds no files')];
  const analyses: Analysis[] = [];
  for (const inner of entries) {
    // A ZIP in a ZIP is not unpacked again.
    analyses.push(...(await analyse(inner, importedAt)));
  }
  return analyses;
}
