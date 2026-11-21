// SPDX-License-Identifier: AGPL-3.0-or-later
// Where ridrs Scenic finds its data. The site lives in ridrs_app/web/scenic (or in a worktree of it); the data pipeline,
// its export/ and the local wrangler state stay outside the repository, in a folder pov-atlas found by walking up from
// here (Ridrs/pov-atlas). SCENIC_PIPELINE overrides it.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..'); // web/scenic

function findPipeline() {
  if (process.env.SCENIC_PIPELINE) return resolve(process.env.SCENIC_PIPELINE);
  for (let dir = dirname(ROOT); dir !== dirname(dir); dir = dirname(dir)) {
    const candidate = join(dir, 'pov-atlas');
    if (existsSync(join(candidate, 'export')) || existsSync(join(candidate, 'scripts/export_public.py'))) return candidate;
  }
  throw new Error('Pipeline folder not found: set SCENIC_PIPELINE to the folder with export/ (Ridrs/pov-atlas).');
}

export const PIPELINE = findPipeline();
export const RIDRS = resolve(PIPELINE, '..'); // catalog-web (time-synced tracks) sits next to it
export const STATE = join(PIPELINE, 'dev-state');
// The Van Gestel catalog in this repository (content/vangestel, written by `pnpm fetch:video-catalog`); SCENIC_VANGESTEL overrides it.
export const VANGESTEL = resolve(process.env.SCENIC_VANGESTEL ?? join(ROOT, '../../content/vangestel')); // wrangler --persist-to: local D1 and R2, shared by every checkout
