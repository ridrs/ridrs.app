// SPDX-License-Identifier: AGPL-3.0-or-later
// The rides of Fred Van Gestel (cycling.vangestel.online) as ridrs Scenic imports and builds them. The catalog lives in
// <pipeline>/vangestel, written by ridrs_app `pnpm fetch:video-catalog --out <pipeline>/vangestel`
// (scripts/fetch-video-catalog.ts): index.json, <slug>/package/ (the package without its video, ADR 0095),
// <slug>/thumbnail.jpg (made by hand, never overwritten by the tool), <slug>/overlay/ (ADR 0094).
// Content license: CC BY-NC-SA 4.0 of its author; Scenic shows the credits with every route.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** Prefix of Scenic's ids of Van Gestel routes (`vg-<slug>`). What a video is, says `video.source`, never the id. */
export const PREFIX = 'vg-';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fileFacts = (file, path) => { const bytes = readFileSync(file); return { path, size: bytes.length, sha256: sha256(bytes) }; };

function filesBelow(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.')) continue;
    const file = join(dir, name);
    if (statSync(file).isDirectory()) out.push(...filesBelow(file));
    else out.push(file);
  }
  return out;
}

/**
 * ISO 3166-1 alpha-2 code of a country by its English name (the catalog writes "France"), from Intl. Codes that Intl
 * canonicalizes to another one (DD → DE, FX → FR, YU …) are historic and left out.
 */
const COUNTRY = (() => {
  const names = new Intl.DisplayNames('en', { type: 'region' }), out = new Map();
  for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
    const code = String.fromCharCode(a, b);
    try {
      if (Intl.getCanonicalLocales(`und-${code}`)[0] !== `und-${code}`) continue;
      const n = names.of(code)?.toLowerCase();
      if (n && n !== code.toLowerCase()) out.set(n, code);
    } catch { /* not a region */ }
  }
  return out;
})();
export const countryCode = (name) => (name ? COUNTRY.get(String(name).toLowerCase()) ?? null : null);

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** `Dec 23` (the site's list) as `2023-12-01`; null if it reads otherwise. */
export function addedDate(added) {
  const m = /^([A-Za-z]{3})\w*\s+(\d{2})$/.exec(String(added ?? '').trim());
  const month = m ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
  return month < 0 ? null : `20${m[2]}-${String(month + 1).padStart(2, '0')}-01`;
}

/** [lat, lon] of every track point of a GPX file, in order. */
export function gpxLine(text) {
  const out = [];
  for (const m of text.matchAll(/<trkpt\b([^>]*)>/g)) {
    const lat = /\blat="([^"]+)"/.exec(m[1]), lon = /\blon="([^"]+)"/.exec(m[1]);
    if (lat && lon) out.push([Number(lat[1]), Number(lon[1])]);
  }
  return out;
}

/**
 * The catalog of a folder, or null when there is none (the import then leaves the Van Gestel rows alone).
 * Per route: {id, slug, source, route (its row of index.json), country, line, gpx (path in the package), package, thumbnail, overlay}.
 */
export function loadVanGestel(dir) {
  const index = join(dir, 'index.json');
  if (!existsSync(index)) return null;
  const catalog = JSON.parse(readFileSync(index, 'utf8'));
  if (catalog.format !== 'ridrs-video-catalog' || catalog.version !== 1) throw new Error(`${index}: not a ridrs-video-catalog, version 1`);
  return catalog.routes.map((route) => {
    const folder = join(dir, route.id), pkg = join(folder, 'package');
    if (!existsSync(pkg)) throw new Error(`${route.id}: no package/ (run pnpm fetch:video-catalog)`);
    const pack = filesBelow(pkg).map((file) => fileFacts(file, relative(pkg, file).split(sep).join('/')));
    const gpx = pack.find((f) => f.path.toLowerCase().endsWith('.gpx'));
    if (!gpx) throw new Error(`${route.id}: no GPX track in package/`);
    const thumb = join(folder, 'thumbnail.jpg');
    return {
      id: `${PREFIX}${route.id}`,
      slug: route.id,
      source: catalog.source,
      route,
      country: countryCode(route.country),
      line: gpxLine(readFileSync(join(pkg, gpx.path), 'utf8')),
      gpx: gpx.path,
      package: pack,
      thumbnail: existsSync(thumb) ? fileFacts(thumb, 'thumbnail.jpg') : null,
      // index.json lists the overlay with its hashes (the tool reads the folder); trust the folder, it is what the build ships.
      overlay: existsSync(join(folder, 'overlay')) ? filesBelow(join(folder, 'overlay')).map((f) => fileFacts(f, relative(join(folder, 'overlay'), f).split(sep).join('/'))) : [],
    };
  });
}

/** Every n-th point so that at most `max` remain, the last one always kept. */
export function thin(points, max) {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => points[Math.round(i * step)]);
}

/** Elevation facts of a sparkline over `distance` m: profile [[km, ele], …] (≤ 200 points), descent, max gradient over about 200 m. */
export function elevation(sparkline, distance) {
  const n = sparkline.length, spacing = distance / Math.max(1, n - 1);
  const profile = thin(sparkline.map((e, i) => [Math.round((i * spacing) / 10) / 100, Math.round(e)]), 200);
  let descent = 0;
  for (let i = 1; i < n; i++) descent += Math.max(0, sparkline[i - 1] - sparkline[i]);
  const w = Math.max(1, Math.round(200 / spacing));
  let max = 0;
  for (let i = w; i < n; i++) max = Math.max(max, ((sparkline[i] - sparkline[i - w]) / (w * spacing)) * 100);
  return { profile, descent: Math.round(descent), maxGradient: Math.round(max * 10) / 10 };
}
