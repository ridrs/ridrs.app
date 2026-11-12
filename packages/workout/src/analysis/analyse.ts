// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Workout, WorkoutStep } from '@ridrs/contracts';
import type { WorkoutDiagnostic } from '../codec.ts';
import { isHeartRateUnit, isPowerUnit } from '../core/resolve.ts';
import { validateWorkout } from '../core/validate.ts';
import { detectWorkoutFormat, WORKOUT_IMPORTERS } from './formats.ts';
import { type FileEntry, unzipFiles } from './zip.ts';

/** What a rider should know about an imported workout, apart from the importer's diagnostics. */
export type WorkoutNote =
  /** The units of the power targets: what is ridden how. Nothing is converted. */
  | { readonly kind: 'units'; readonly units: readonly ('watts' | 'percent-ftp' | 'power-zone')[] }
  /** Steps ERG cannot hold, by the reason. */
  | { readonly kind: 'no-erg'; readonly reason: NoErgReason; readonly count: number }
  | { readonly kind: 'diagnostic'; readonly diagnostic: WorkoutDiagnostic };

export type NoErgReason = 'heart-rate' | 'speed' | 'rpe' | 'free' | 'max-effort';

/** The result for one workout of a file, or for a file that gave none. */
export type WorkoutAnalysis =
  | {
      readonly kind: 'workout';
      readonly fileName: string;
      readonly hash: string;
      /** The bytes of the file, kept as the original. */
      readonly bytes: Uint8Array;
      readonly workout: Workout;
      readonly notes: readonly WorkoutNote[];
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

const fail = (fileName: string, code: string, message: string): WorkoutAnalysis => ({
  kind: 'error',
  fileName,
  diagnostics: [{ severity: 'error', code, message }],
});

function intervals(steps: readonly WorkoutStep[]): Extract<WorkoutStep, { kind: 'interval' }>[] {
  return steps.flatMap((step) => (step.kind === 'repeat' ? intervals(step.steps) : [step]));
}

/** The notes that explain a workout: its power units, and the steps ERG cannot ride. */
export function workoutNotes(workout: Workout): WorkoutNote[] {
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
  const notes: WorkoutNote[] = [];
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
export async function analyseWorkoutEntry(
  entry: FileEntry,
  importedAt: string,
): Promise<WorkoutAnalysis[]> {
  const { fileName, bytes } = entry;
  if (bytes.length === 0) return [fail(fileName, 'empty-file', 'The file is empty')];
  const format = detectWorkoutFormat(fileName, bytes);
  if (format === undefined || format === 'zip') {
    return [
      fail(fileName, 'unknown-format', 'ridrs cannot tell which workout format the file has'),
    ];
  }
  const hash = await sha256Hex(bytes);
  let result: ReturnType<(typeof WORKOUT_IMPORTERS)[typeof format]>;
  try {
    result = WORKOUT_IMPORTERS[format](bytes, { fileName, originalHash: hash, importedAt });
  } catch (error) {
    return [fail(fileName, 'import-failed', String(error))];
  }
  if (!result.ok) return [{ kind: 'error', fileName, diagnostics: result.diagnostics }];
  if (result.workouts.length === 0) {
    return [{ kind: 'error', fileName, diagnostics: result.diagnostics }];
  }
  return result.workouts.map((workout): WorkoutAnalysis => {
    const problems = validateWorkout(workout);
    if (problems.length > 0) return { kind: 'error', fileName, diagnostics: problems };
    const notes: WorkoutNote[] = [
      ...workoutNotes(workout),
      ...result.diagnostics.map((diagnostic): WorkoutNote => ({ kind: 'diagnostic', diagnostic })),
    ];
    const state =
      result.diagnostics.some((d) => d.severity === 'warning') ||
      notes.some((n) => n.kind === 'no-erg')
        ? 'warning'
        : 'ok';
    return { kind: 'workout', fileName, hash, bytes, workout, notes, state };
  });
}

/** A text pasted from an intervals.icu description, as the workout `name`. */
export async function analyseWorkoutText(
  text: string,
  name: string,
  importedAt: string,
): Promise<WorkoutAnalysis[]> {
  const bytes = new TextEncoder().encode(text);
  const fileName = `${name.trim() || 'workout'}.txt`;
  const hash = await sha256Hex(bytes);
  const result = WORKOUT_IMPORTERS.intervals(text, { fileName, originalHash: hash, importedAt });
  if (!result.ok || result.workouts.length === 0) {
    return [{ kind: 'error', fileName, diagnostics: result.diagnostics }];
  }
  return result.workouts.map((imported): WorkoutAnalysis => {
    const workout: Workout = {
      ...imported,
      id: name.trim() || imported.id,
      name: name.trim() || imported.name,
      source: { ...imported.source, fileName },
    };
    const notes: WorkoutNote[] = [
      ...workoutNotes(workout),
      ...result.diagnostics.map((diagnostic): WorkoutNote => ({ kind: 'diagnostic', diagnostic })),
    ];
    const state =
      result.diagnostics.some((d) => d.severity === 'warning') ||
      notes.some((n) => n.kind === 'no-erg')
        ? 'warning'
        : 'ok';
    return { kind: 'workout', fileName, hash, bytes, workout, notes, state };
  });
}

/** A file, or every file of a ZIP, read; a ZIP that cannot be read is one error. */
export async function analyseWorkoutFile(
  entry: FileEntry,
  importedAt: string,
): Promise<WorkoutAnalysis[]> {
  if (detectWorkoutFormat(entry.fileName, entry.bytes) !== 'zip')
    return analyseWorkoutEntry(entry, importedAt);
  let entries: FileEntry[];
  try {
    entries = await unzipFiles(entry.bytes);
  } catch {
    return [fail(entry.fileName, 'bad-zip', 'The ZIP file cannot be read')];
  }
  if (entries.length === 0)
    return [fail(entry.fileName, 'empty-zip', 'The ZIP file holds no files')];
  const analyses: WorkoutAnalysis[] = [];
  for (const inner of entries) {
    // A ZIP in a ZIP is not unpacked again.
    analyses.push(...(await analyseWorkoutEntry(inner, importedAt)));
  }
  return analyses;
}
