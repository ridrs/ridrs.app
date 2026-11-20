// SPDX-License-Identifier: AGPL-3.0-or-later
// Imports ../export (scripts/export_public.py) into D1 (concept 4.3).
//   node scripts/import.mjs            -> local D1 (wrangler dev)
//   node scripts/import.mjs --remote   -> the Cloudflare D1 database
// Writes build/import.sql first, then runs it with wrangler. Pipeline and YouTube API fields are
// upserted; editorial fields (stars, editor_note, editors_pick, hidden), every field set by hand in the
// admin (manual_field: place, region, pin, country, route, localization, sync) and a localization that a
// person verified (verified_at set) are never overwritten. The SQL is built in lib/import-sql.mjs.
//   node scripts/import.mjs --dry-run  -> only writes build/import.sql
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadSyncTracks } from './lib/sync-sources.mjs';
import { buildImportSql } from './lib/import-sql.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
import { PIPELINE, RIDRS, STATE } from './lib/paths.mjs'; // the data pipeline folder (export/) lives outside the repository
const remote = process.argv.includes('--remote');
const today = new Date().toISOString().slice(0, 10);

const ndjson = (f) => readFileSync(join(PIPELINE, 'export', f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const videos = ndjson('videos.ndjson');
const yt = new Map(ndjson('youtube_snapshot.ndjson').map((r) => [r.video_id, r]));
const sync = new Map(loadSyncTracks(RIDRS).map((t) => [t.videoId, t]));

const { sql, routes, channels: channelCount, countries } = buildImportSql({ videos, yt, sync, today });

mkdirSync(join(ROOT, 'build'), { recursive: true });
const file = join(ROOT, 'build/import.sql');
writeFileSync(file, sql.join('\n') + '\n');
console.log(`build/import.sql: ${videos.length} videos, ${routes} routes, ${channelCount} channels, ${sync.size} sync tracks, ${sql.length} statements`);
const withCountry = videos.length - (countries.get(null) ?? 0);
console.log(`country: ${withCountry} of ${videos.length} videos (${(100 * withCountry / videos.length).toFixed(1)} %), ${countries.size - (countries.has(null) ? 1 : 0)} countries; top: ${
  [...countries].filter(([c]) => c).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([c, n]) => `${c} ${n}`).join(', ')}`);
if (process.argv.includes('--dry-run')) process.exit(0);
execFileSync('npx', ['wrangler', 'd1', 'execute', 'ridrs-scenic', ...(remote ? ['--remote'] : ['--local', '--persist-to', STATE]), '--file', file, '--yes'], { cwd: ROOT, stdio: 'inherit' });
