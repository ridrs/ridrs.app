// SPDX-License-Identifier: AGPL-3.0-or-later

import { type Workout, workoutSchema } from '@ridrs/contracts';
import { importFit, importZwo, validateWorkout } from '@ridrs/workout';

/** What a source lacks, from `sources/<name>.meta.json` (ADR 0086). */
export type CatalogueMeta = Pick<Workout, 'sport' | 'author' | 'license' | 'focus' | 'category' | 'subcategory' | 'tags'>;

/**
 * The canonical workout of a source: the same importer as the rider's import, the meta file
 * merged over it. No clock and no hash, so that the output is the same on every run.
 */
export function convertSource(
  name: string,
  source: string | Uint8Array,
  meta: CatalogueMeta,
  format: 'zwo' | 'fit' = 'zwo',
): Workout {
  const fileName = `${name}.${format}`;
  const options = { id: name, fileName, sourceKind: 'builtin' } as const;
  const result = format === 'zwo' ? importZwo(source, options) : importFit(source, options);
  if (!result.ok || result.workouts.length !== 1 || !result.workouts[0]) {
    throw new Error(`${fileName}: ${result.diagnostics.map((d) => d.message).join('; ')}`);
  }
  const workout = workoutSchema.parse({ ...result.workouts[0], ...meta });
  const problems = validateWorkout(workout);
  if (problems.length > 0) {
    throw new Error(`${fileName}: ${problems.map((p) => p.message).join('; ')}`);
  }
  return workout;
}

/** The text of a canonical file. */
export const canonicalText = (workout: Workout): string => `${JSON.stringify(workout, null, 2)}\n`;
