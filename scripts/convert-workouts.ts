// SPDX-License-Identifier: AGPL-3.0-or-later

// Writes plugins/library-ridrs/resources/workouts/<id>.json from sources/*.zwo with the importer
// of the rider's import, merging sources/<name>.meta.json (ADR 0086). A test fails when a file is
// out of date.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalText, convertSource } from '../plugins/library-ridrs/convert.ts';

const dir = resolve(import.meta.dirname, '../plugins/library-ridrs/resources/workouts');
for (const file of readdirSync(resolve(dir, 'sources')).sort()) {
  const format = file.endsWith('.zwo') ? 'zwo' : file.endsWith('.fit') ? 'fit' : undefined;
  if (!format) continue;
  const name = file.slice(0, -`.${format}`.length);
  const meta = JSON.parse(readFileSync(resolve(dir, 'sources', `${name}.meta.json`), 'utf8'));
  const workout = convertSource(name, readFileSync(resolve(dir, 'sources', file), format === 'zwo' ? 'utf8' : undefined), meta, format);
  writeFileSync(resolve(dir, `${name}.json`), canonicalText(workout));
  console.log(`wrote ${name}.json`);
}
