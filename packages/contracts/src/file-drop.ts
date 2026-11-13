// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { defineState } from './app-state.ts';
import { routeImportPreviewSchema } from './route.ts';
import { defineService } from './services.ts';
import { workoutSchema } from './workout.ts';

/** A workout of a dragged file, as the library would get it. */
export const droppedWorkoutSchema = z
  .object({
    workout: workoutSchema,
    /** `duplicate`: the same file content and name is in the library already; it is not added again. */
    state: z.enum(['ok', 'warning', 'duplicate']),
  })
  .strict();

/** What ridrs makes of a file dragged onto the window (ADR 0093). */
export const droppedFileSchema = z
  .object({
    /** The file's id of `data.drop`. */
    id: z.string().min(1),
    name: z.string().min(1),
    size: z.number().int().nonnegative(),
    verdict: z.discriminatedUnion('kind', [
      /** Still being read. */
      z.object({ kind: z.literal('reading') }).strict(),
      /** Workouts for the ridrs library: one file, or every workout of a ZIP. */
      z
        .object({ kind: z.literal('workouts'), workouts: z.array(droppedWorkoutSchema).min(1) })
        .strict(),
      /** A route of the provider `provider` of `route.import`, as it would be. */
      z
        .object({
          kind: z.literal('route'),
          provider: z.string().min(1),
          preview: routeImportPreviewSchema.options[0].shape.preview,
        })
        .strict(),
      /** Nothing ridrs can import, and why. */
      z.object({ kind: z.literal('refused'), reason: z.string().min(1) }).strict(),
    ]),
  })
  .strict();

export type DroppedFileVerdict = z.infer<typeof droppedFileSchema>;

/**
 * Files dragged over the window, and what letting go of them did: one key, `window`, owned by
 * `file-drop`; gone when the drag leaves the window. `over` while they hover, `importing` once
 * they were let go, `done` with what was added: workouts saved, workouts left out because the
 * library has them, video routes whose import started, and imports that failed.
 */
export const fileDropSchema = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('over'), files: z.array(droppedFileSchema) }).strict(),
  z.object({ phase: z.literal('importing'), files: z.array(droppedFileSchema) }).strict(),
  z
    .object({
      phase: z.literal('done'),
      files: z.array(droppedFileSchema),
      saved: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
      routes: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      /** The files were moved: each leaves where it lay once what it holds is in ridrs. */
      moved: z.boolean(),
    })
    .strict(),
]);

export type FileDrop = z.infer<typeof fileDropSchema>;

/** The key of `file.drop`: there is one window. */
export const FILE_DROP_KEY = 'window';

export const fileDropState = defineState('file.drop', fileDropSchema);

/**
 * Adds what is being dragged to the library, once it is let go over the layer that shows it (ADR
 * 0093): answered when the workouts are saved and the imports of video routes started; the outcome
 * is the state `done`. A drag that left the window, or one with nothing to import, adds nothing.
 * With `move` (the platform's move key held while letting go), each file is removed from where it
 * lay once what it holds is in ridrs: workouts once saved or found in the library, a video route
 * once imported. A file whose import failed stays where it lay.
 */
export const fileDropImportService = defineService('file.drop.import', {
  request: z.object({ move: z.boolean().optional() }).strict(),
  response: z.object({}).strict(),
});

/**
 * Forgets the drag as if it had left the window (Escape over the layer): `file.drop` is gone, and
 * letting go of the same drag afterwards adds nothing.
 */
export const fileDropCancelService = defineService('file.drop.cancel', {
  request: z.object({}).strict(),
  response: z.object({}).strict(),
});
