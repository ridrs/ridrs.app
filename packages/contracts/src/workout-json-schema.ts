// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { workoutSchema } from './workout.ts';

/** JSON Schema (draft 2020-12) of a ridrs workout v1 file, generated from the zod schemas. */
export function workoutJsonSchema(): Record<string, unknown> {
  return {
    title: 'ridrs workout v1',
    description: 'A cycling workout in the canonical ridrs format. See ridrs-workout-v1.md.',
    ...z.toJSONSchema(workoutSchema, { io: 'input' }),
  };
}
