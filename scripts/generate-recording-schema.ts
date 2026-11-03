// SPDX-License-Identifier: AGPL-3.0-or-later

// Writes docs/formats/ridrs-recording-v1.schema.json from the zod schemas in
// packages/contracts/src/recording.ts. A Vitest test fails when the file is out of date.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { recordingJsonSchema } from '../packages/contracts/src/recording-json-schema.ts';

const target = resolve(import.meta.dirname, '../docs/formats/ridrs-recording-v1.schema.json');
writeFileSync(target, `${JSON.stringify(recordingJsonSchema(), null, 2)}\n`);
console.log(`wrote ${target}`);
