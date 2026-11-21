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

/** The ride catalog (format ridrs-scenic-ride-catalog, version 1) of the rows; `site` = origin + base path. */
export function rideCatalog(rows, site) {
  const sources = {};
  const routes = rows.map((r) => {
    sources[r.source] ??= { name: r.source_name, author: r.author, url: r.source_url,
      license: { id: r.license_id, name: r.license_name, url: r.license_url } };
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
  return { format: 'ridrs-scenic-ride-catalog', version: 1, sources, routes };
}
