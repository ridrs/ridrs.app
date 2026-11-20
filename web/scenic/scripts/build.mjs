// SPDX-License-Identifier: AGPL-3.0-or-later
// Builds dist/scenic/ (the site lives under ridrs.app/scenic, BASE_PATH in wrangler.jsonc): the static site, vendored MapLibre, the GPX files from ../export/routes (OSM-derived
// only, see ../scripts/export_public.py) and the time-synced tracks (sync/<videoId>.json).
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSyncTracks } from './lib/sync-sources.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
import { PIPELINE, RIDRS } from './lib/paths.mjs'; // the data pipeline folder (export/) lives outside the repository
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

const tracks = loadSyncTracks(RIDRS);
mkdirSync(join(dist, 'sync'));
for (const t of tracks) writeFileSync(join(dist, 'sync', `${t.videoId}.json`), t.raw);

// All route lines for the overview map (lines.json): the OSM-derived lines of the export, simplified
// (Douglas-Peucker, ~30 m) and stored as {videoId: [lon0, lat0, dlon1, dlat1, …]} in integer 1e-5 degrees
// (~1 m), delta-encoded so it compresses well. site/app.js decodes it. The dialog keeps the full line.
const TOL = 0.0003;
function simplify(pts) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b], k = Math.cos((ay * Math.PI) / 180);
    const dx = (bx - ax) * k, dy = by - ay, len2 = dx * dx + dy * dy;
    let best = -1, bestD = TOL * TOL;
    for (let i = a + 1; i < b; i++) {
      const px = (pts[i][0] - ax) * k, py = pts[i][1] - ay;
      const t = len2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / len2)) : 0;
      const d = (px - t * dx) ** 2 + (py - t * dy) ** 2;
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best > 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
const lines = {};
let linePts = 0;
for (const row of readFileSync(join(PIPELINE, 'export/videos.ndjson'), 'utf8').split('\n')) {
  if (!row) continue;
  const v = JSON.parse(row), line = v.route?.line;
  if (!line || line.length < 2) continue;
  addLine(v.video_id, line.map(([la, lo]) => [lo, la]));
}
// Synced videos without an exported OSM route still get a line: the sync track ({c: [[lon, lat], …]}).
// Anchor-based tracks from the admin (D1, /api/sync/:id.json) are not part of this static build.
for (const t of tracks) if (!lines[t.videoId]) addLine(t.videoId, JSON.parse(t.raw).c);
function addLine(id, lonLat) {
  if (!lonLat || lonLat.length < 2) return;
  const s = simplify(lonLat);
  const flat = []; let px = 0, py = 0;
  for (const [lo, la] of s) { const x = Math.round(lo * 1e5), y = Math.round(la * 1e5); flat.push(x - px, y - py); px = x; py = y; }
  lines[id] = flat; linePts += s.length;
}
const linesJson = JSON.stringify(lines);
writeFileSync(join(dist, 'lines.json'), linesJson);

console.log(`dist: ${Object.keys(lines).length} route lines (${linePts} points, ${(linesJson.length / 1048576).toFixed(1)} MB)`);
console.log(`dist: ${gpx} GPX (${tooBig} over 25 MB skipped), ${tracks.length} sync tracks`);
