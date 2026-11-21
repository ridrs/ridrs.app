// SPDX-License-Identifier: AGPL-3.0-or-later
// Builds dist/scenic/ (the site lives under ridrs.app/scenic, BASE_PATH in wrangler.jsonc): the static site, vendored MapLibre, the GPX files from ../export/routes (OSM-derived
// only, see ../scripts/export_public.py), the time-synced tracks (sync/<videoId>.json) and the Van Gestel rides (vg/<slug>/: thumbnail,
// overlay and the package without its video; gpx/vg-<slug>.gpx, the creator's track; their lines in lines.json).
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSyncTracks } from './lib/sync-sources.mjs';
import { encodeLine } from '../site/lib/lines.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
import { PIPELINE, RIDRS, VANGESTEL } from './lib/paths.mjs'; // the data pipeline folder (export/) lives outside the repository
import { loadVanGestel } from './lib/vangestel.mjs';
import { makeThumbnails } from './lib/thumbnails.mjs';
import { overlayPicture } from '../src/rides.js';
const BASE = 'scenic'; // keep in sync with BASE_PATH in wrangler.jsonc
const distRoot = join(ROOT, 'dist');
const dist = join(distRoot, BASE);
const MAX_ASSET = 25 * 1024 * 1024; // Cloudflare limit per static asset

rmSync(distRoot, { recursive: true, force: true });
mkdirSync(join(dist, 'vendor/maplibre-gl'), { recursive: true });
cpSync(join(ROOT, 'site'), dist, { recursive: true });

const ml = join(ROOT, 'node_modules/maplibre-gl');
for (const f of readdirSync(join(ml, 'dist'))) {
  if (/\.(mjs|css)$/.test(f) && !f.includes('-dev')) cpSync(join(ml, 'dist', f), join(dist, 'vendor/maplibre-gl', f));
}
cpSync(join(ml, 'LICENSE.txt'), join(dist, 'vendor/maplibre-gl/LICENSE.txt'));

// ridrs typefaces, self-hosted (no Google Fonts request): the weights style.css uses, latin + latin-ext only.
const FONTS = { 'chakra-petch': ['600-italic', '700-italic'], 'jetbrains-mono': ['500'], 'plus-jakarta-sans': ['400', '500', '600', '700'] };
const fontCss = [];
mkdirSync(join(dist, 'vendor/fonts'), { recursive: true });
for (const [pkg, weights] of Object.entries(FONTS)) {
  const dir = join(ROOT, 'node_modules/@fontsource', pkg);
  cpSync(join(dir, 'LICENSE'), join(dist, 'vendor/fonts', `${pkg}.LICENSE`));
  for (const w of weights) for (const subset of ['latin-ext', 'latin']) {
    const css = readFileSync(join(dir, `${subset}-${w}.css`), 'utf8')
      .replace(/, url\([^)]*\.woff\) format\('woff'\)/g, '')
      .replace(/url\(\.\/files\/([^)]+\.woff2)\)/g, (_, f) => { cpSync(join(dir, 'files', f), join(dist, 'vendor/fonts', f)); return `url(${f})`; });
    fontCss.push(css);
  }
}
writeFileSync(join(dist, 'vendor/fonts/fonts.css'), fontCss.join('\n'));

let gpx = 0, tooBig = 0;
const gpxSrc = join(PIPELINE, 'export/routes');
mkdirSync(join(dist, 'gpx'));
for (const f of readdirSync(gpxSrc)) {
  if (statSync(join(gpxSrc, f)).size > MAX_ASSET) { tooBig++; continue; }
  cpSync(join(gpxSrc, f), join(dist, 'gpx', f)); gpx++;
}

// Van Gestel rides: their files under vg/<slug>/ (served only for visible videos, src/worker.js), the track as GPX.
const rides = loadVanGestel(VANGESTEL) ?? [];
const THUMB_CACHE = join(ROOT, 'build/thumbs');
let thumbs = 0;
for (const r of rides) {
  const from = join(VANGESTEL, r.slug), to = join(dist, 'vg', r.slug);
  mkdirSync(to, { recursive: true });
  if (r.thumbnail) cpSync(join(from, 'thumbnail.jpg'), join(to, 'thumbnail.jpg'));
  for (const dir of ['overlay', 'package']) if (existsSync(join(from, dir))) cpSync(join(from, dir), join(to, dir), { recursive: true, filter: (f) => !f.split('/').at(-1).startsWith('.') });
  // Small web versions of the overlay's big picture for the dialog (vg/<slug>/web/), cached by the picture's hash in build/.
  const pic = overlayPicture(r.overlay);
  if (pic) thumbs += (await makeThumbnails(join(from, 'overlay', pic.path), join(to, 'web'), { cache: THUMB_CACHE, key: pic.sha256 })).some((m) => !m.cached) ? 1 : 0;
  cpSync(join(from, 'package', r.gpx), join(dist, 'gpx', `${r.id}.gpx`));
}

const tracks = loadSyncTracks(RIDRS);
mkdirSync(join(dist, 'sync'));
for (const t of tracks) writeFileSync(join(dist, 'sync', `${t.videoId}.json`), t.raw);

// All route lines for the overview map (lines.json): the OSM-derived lines of the export, simplified and delta-encoded by
// site/lib/lines.js (shared with the worker, which lays the lines set in the admin over these, and with site/app.js).
const lines = {};
let linePts = 0;
for (const row of readFileSync(join(PIPELINE, 'export/videos.ndjson'), 'utf8').split('\n')) {
  if (!row) continue;
  const v = JSON.parse(row), line = v.route?.line;
  if (!line || line.length < 2) continue;
  addLine(v.video_id, line.map(([la, lo]) => [lo, la]));
}
// Synced videos without an exported OSM route still get a line: the sync track ({c: [[lon, lat], …]}).
// Lines set in the admin (D1: manual routes, uploaded video2gpx tracks) are added by the worker (src/worker.js linesJson).
for (const t of tracks) if (!lines[t.videoId]) addLine(t.videoId, JSON.parse(t.raw).c);
for (const r of rides) addLine(r.id, r.line.map(([la, lo]) => [lo, la]));
function addLine(id, lonLat) {
  const flat = encodeLine(lonLat);
  if (!flat) return;
  lines[id] = flat; linePts += flat.length / 2;
}
const linesJson = JSON.stringify(lines);
writeFileSync(join(dist, 'lines.json'), linesJson);

console.log(`dist: ${Object.keys(lines).length} route lines (${linePts} points, ${(linesJson.length / 1048576).toFixed(1)} MB)`);
console.log(`dist: ${gpx} GPX (${tooBig} over 25 MB skipped), ${tracks.length} sync tracks, ${rides.length} Van Gestel rides (${thumbs} pictures resized, the others from build/thumbs)`);
