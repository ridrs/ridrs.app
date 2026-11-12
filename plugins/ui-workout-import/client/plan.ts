// SPDX-License-Identifier: AGPL-3.0-or-later

import type { WorkoutAnalysis } from '@ridrs/workout';

export type DuplicateChoice = 'skip' | 'copy';

/** A workout of the library as far as the import needs it. */
export interface KnownWorkout {
  readonly id: string;
  readonly name: string;
  readonly originalHash?: string;
}

export interface PlannedRow {
  readonly key: string;
  readonly analysis: WorkoutAnalysis;
  /** The workout this one repeats: the same file content and name, in the library or above it. */
  readonly duplicateOf?: string;
  readonly choice: DuplicateChoice;
  /** The id the workout is saved under; only for a workout that will be imported. */
  readonly id?: string;
}

const slug = (text: string) =>
  text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/**
 * An id from the file name (what the importer derived), else with the start of the hash, else
 * counted: the same files give the same ids, and no id is used twice in the library or the
 * batch. A copy always carries the hash, so it never takes the id of its original.
 */
export function chooseId(base: string, hash: string, taken: ReadonlySet<string>, copy: boolean): string {
  const root = slug(base) || 'workout';
  if (!copy && !taken.has(root)) return root;
  const hashed = `${root}-${hash.slice(0, 8)}`;
  if (!taken.has(hashed)) return hashed;
  for (let n = 2; ; n += 1) {
    if (!taken.has(`${hashed}-${n}`)) return `${hashed}-${n}`;
  }
}

/**
 * The plan of an import: for each analysis its duplicate state and, for the ones that will be
 * saved, their ids. Recomputed whenever the rows or a choice change.
 */
export function planImport(
  analyses: readonly { key: string; analysis: WorkoutAnalysis }[],
  known: readonly KnownWorkout[],
  choices: ReadonlyMap<string, DuplicateChoice>,
): PlannedRow[] {
  const taken = new Set(known.map((workout) => workout.id));
  const seen = new Map<string, string>();
  for (const workout of known) {
    if (workout.originalHash) seen.set(`${workout.originalHash}|${workout.name}`, workout.name);
  }
  return analyses.map(({ key, analysis }): PlannedRow => {
    const choice = choices.get(key) ?? 'skip';
    if (analysis.kind === 'error') return { key, analysis, choice };
    const signature = `${analysis.hash}|${analysis.workout.name}`;
    const duplicateOf = seen.get(signature);
    seen.set(signature, analysis.workout.name);
    if (duplicateOf !== undefined && choice === 'skip') return { key, analysis, duplicateOf, choice };
    const id = chooseId(analysis.workout.id, analysis.hash, taken, duplicateOf !== undefined);
    taken.add(id);
    return { key, analysis, ...(duplicateOf === undefined ? {} : { duplicateOf }), choice, id };
  });
}
