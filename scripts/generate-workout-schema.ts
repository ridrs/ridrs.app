// SPDX-License-Identifier: AGPL-3.0-or-later

// Writes docs/formats/ridrs-workout-v1.schema.json from the zod schemas in
// packages/contracts/src/workout.ts. A Vitest test fails when the file is out of date.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { workoutJsonSchema } from '../packages/contracts/src/workout-json-schema.ts';

const target = resolve(import.meta.dirname, '../docs/formats/ridrs-workout-v1.schema.json');
writeFileSync(target, `${JSON.stringify(workoutJsonSchema(), null, 2)}\n`);
console.log(`wrote ${target}`);
