// SPDX-License-Identifier: AGPL-3.0-or-later
// Rides of a source with ride packages (Van Gestel, migrations/0007): the package without its video as a ZIP, and the
// ride catalog of the ridrs app (ridrs_app docs/formats/scenic-ride-catalog-v1.md). Files of a ride are static assets of
// the build under vg/<slug>/ (scripts/build.mjs); the worker serves them only for visible videos.
import { strToU8, zipSync } from 'fflate';

const parse = (s) => { try { return s == null ? null : JSON.parse(s); } catch { return null; } };
export const slugOf = (id) => id.replace(/^vg-/, '');
const assetPath = (path) => path.split('/').map(encodeURIComponent).join('/');
const hashed = (url, sha) => (sha ? `${url}?h=${sha.slice(0, 12)}` : url);
const isPicture = (path) => /\.(jpe?g|png|webp)$/i.test(path);

/** Widths of the web versions of a ride's overlay picture, built into vg/<slug>/web/ (scripts/lib/thumbnails.mjs). */
export const PICTURE_WIDTHS = [640, 1280];
export const pictureName = (w) => `picture-${w}.jpg`;
/** The overlay picture among a ride's overlay files (the big one the web versions are made from), or undefined. */
export const overlayPicture = (overlay) => (overlay ?? []).find((f) => isPicture(f.path));

/**
 * A ride's picture for the dialog: the web versions of the overlay's picture ({url, srcset}; the original's hash busts
 * the cache), else the small thumbnail; null without either. The original in full size is for the app's package only.
 */
export function ridePicture(id, p) {
  const root = `vg/${slugOf(id)}`, overlay = overlayPicture(parse(p.overlay));
  if (overlay) {
    const web = (w) => hashed(`${root}/web/${pictureName(w)}`, overlay.sha256);
    return { url: web(PICTURE_WIDTHS.at(-1)), srcset: PICTURE_WIDTHS.map((w) => `${web(w)} ${w}w`).join(', ') };
  }
  return parse(p.thumbnail) ? { url: `${root}/thumbnail.jpg`, srcset: null } : null;
}

const readme = (p) => `Paket ohne Video / Package without video
========================================

${p.title}
${p.page_url ?? ''}

DE: Steuerdatei und Track des Originalpakets, Byte für Byte, ohne das Video, dazu die Dateien, mit denen ridrs Scenic
das Paket verbessert (z. B. das Vorschaubild). Das Video gibt es nur im Original-Download der Seite oben: legt es neben
diese Dateien, dann ist der Ordner wieder das ganze Paket (Incyclist: gpx-import).

EN: Control file and track of the original package, byte for byte, without the video, plus the files with which ridrs
Scenic improves the package (e.g. the preview picture). The video is only in the original download of the page above:
put it beside these files and the folder is the whole package again (Incyclist: gpx-import).

Inhalt / Content: ${p.author ?? ''}, ${p.source_name ?? ''}
Lizenz / License: ${p.license_name ?? ''} ${p.license_url ?? ''}
Nur für nicht-kommerzielle Nutzung / Non-commercial use only.
Zusammengestellt von / Compiled by ridrs Scenic, https://ridrs.app/scenic/
`;

/** The package without its video (ADR 0095): its files and the overlay over them, with a read-me. */
export async function packageZip(env, row, root) {
  const files = {};
  for (const [dir, list] of [['package', parse(row.package)], ['overlay', parse(row.overlay)]]) {
    for (const f of list ?? []) {
      const res = await env.ASSETS.fetch(new Request(`${root}/${dir}/${assetPath(f.path)}`));
      if (!res.ok) throw new Error(`ride asset ${dir}/${f.path}: HTTP ${res.status}`);
      files[f.path] = new Uint8Array(await res.arrayBuffer());
    }
  }
  files['LIESMICH.txt'] = strToU8(readme(row));
  return zipSync(files, { level: 6 });
}

/** Points of a sparkline: evenly spaced elevations from start to end. */
const SPARKLINE = 100;
/**
 * The bitrate a YouTube video's size is estimated with: YouTube's video stream at 1080p, more at a
 * high frame rate. Scenic's own bitrate is the best format's (4K HDR up to 180 Mbit/s): it counts
 * only where it is lower.
 */
const kbps1080 = (fps) => (fps > 30 ? 12000 : 8000);
/** Ups and downs smaller than this, in m, are noise of the elevation, not climbs. */
const HYSTERESIS = 3;

const RADIUS = 6371008.8;
const rad = (deg) => (deg * Math.PI) / 180;
/** m between two points [lon, lat]. */
function haversine([lon1, lat1], [lon2, lat2]) {
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * RADIUS * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * What a synced track (`{t, c, e}`, one point per video second) says of a ride: its distance in m,
 * the m climbed (ups of at least 3 m), its profile [[km, ele], …] and the s it runs; none without
 * elevations.
 */
export function trackFacts(track) {
  const { t, c, e } = track ?? {};
  if (!Array.isArray(t) || !Array.isArray(c) || !Array.isArray(e) || t.length < 2 || c.length !== t.length || e.length !== t.length) {
    return null;
  }
  let distance = 0;
  let ascent = 0;
  let low = e[0];
  const profile = [[0, e[0]]];
  for (let i = 1; i < t.length; i += 1) {
    distance += haversine(c[i - 1], c[i]);
    profile.push([distance / 1000, e[i]]);
    if (e[i] - low >= HYSTERESIS) {
      ascent += e[i] - low;
      low = e[i];
    } else if (e[i] < low) low = e[i];
  }
  return { distance: Math.round(distance), ascent: Math.round(ascent), profile, duration: t.at(-1) - t[0] };
}

/** `n` elevations evenly spaced along a profile [[km, ele], …], linearly between its points. */
export function sparklineOf(profile, n = SPARKLINE) {
  const end = profile.at(-1)[0];
  let i = 0;
  return Array.from({ length: n }, (_, k) => {
    const km = (end * k) / (n - 1);
    while (i < profile.length - 2 && profile[i + 1][0] < km) i += 1;
    const [a, b] = [profile[i], profile[i + 1] ?? profile[i]];
    const share = b[0] > a[0] ? (km - a[0]) / (b[0] - a[0]) : 0;
    return Math.round(a[1] + (b[1] - a[1]) * Math.min(1, Math.max(0, share)));
  });
}

/** A source of the catalog from a row with its columns; no author for one whose entries name their own. */
const sourceOf = (r) => ({ name: r.source_name, ...(r.author ? { author: r.author } : {}), url: r.source_url,
  license: { id: r.license_id, name: r.license_name, url: r.license_url } });

/**
 * A YouTube video the app can ride with the YouTube downloader (ridrs_app ADR 0105): the package without its video
 * (concept 4.7) and the video's id and frame rate; its size is an estimate, the video at 1080p over the ride's
 * duration. Its channel is its author. `r.track` are the facts of its synced track ({@link trackFacts}), if it has one.
 */
function youtubeRoute(r, site) {
  const route = { id: r.video_id, source: r.source, title: r.title || r.place || r.video_id,
    page: `https://www.youtube.com/watch?v=${r.video_id}` };
  if (r.channel) route.author = r.channel;
  if (r.country) route.country = r.country;
  // The synced track knows the ride best; the route's profile where there is none.
  const facts = r.track ?? { distance: Math.round(r.distance_km * 1000), ascent: r.ascent_m ?? 0, profile: parse(r.profile),
    duration: r.duration_s };
  Object.assign(route, { distance: facts.distance, ascent: facts.ascent, duration: facts.duration,
    sparkline: sparklineOf(facts.profile), climbs: [], overlay: [] });
  const rate = Math.min(r.bitrate_kbps ?? Number.POSITIVE_INFINITY, kbps1080(r.fps ?? 30));
  route.download = { kind: 'youtube', url: `${site}/api/videos/${r.video_id}/incyclist.zip`, format: 'incyclist-gpx-import',
    size: Math.round(((rate * 1000) / 8) * facts.duration), video: r.video_id };
  if (r.fps) route.download.fps = r.fps;
  return route;
}

/**
 * The ride catalog (format ridrs-scenic-ride-catalog, version 1) of the rows with ride packages and of the YouTube
 * videos the app can ride; `site` = origin + base path. Routes in the order of their ids.
 */
export function rideCatalog(rows, site, videos = []) {
  const sources = {};
  for (const r of videos) sources[r.source] ??= sourceOf(r);
  const routes = rows.map((r) => {
    sources[r.source] ??= sourceOf(r);
    const root = `${site}/vg/${slugOf(r.video_id)}`, thumb = parse(r.thumbnail);
    const route = { id: r.video_id, source: r.source, title: r.title, page: r.page_url };
    if (r.country) route.country = r.country;
    if (r.level) route.level = r.level;
    if (r.tour_name) route.tour = { name: r.tour_name, part: r.tour_part };
    Object.assign(route, { distance: r.distance_m, ascent: r.ascent_m, duration: r.duration_s, sparkline: parse(r.sparkline), climbs: parse(r.climbs) ?? [] });
    if (thumb) route.tile = hashed(`${root}/thumbnail.jpg`, thumb.sha256);
    route.overlay = (parse(r.overlay) ?? []).map((f) => ({ ...f, url: hashed(`${root}/overlay/${assetPath(f.path)}`, f.sha256) }));
    route.download = { url: r.download_url, format: r.download_format, size: r.download_size };
    if (r.download_etag) route.download.etag = r.download_etag;
    return route;
  });
  const all = [...routes, ...videos.map((r) => youtubeRoute(r, site))].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { format: 'ridrs-scenic-ride-catalog', version: 1, sources, routes: all };
}
