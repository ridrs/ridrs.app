// SPDX-License-Identifier: AGPL-3.0-or-later
// ridrs Scenic worker (CLOUDFLARE-KONZEPT.md 4.2 and 4.4).
//   GET /api/points         compact list of all visible videos for map, list and client-side filters
//   GET /api/videos/:id     full record of one video
//   GET /api/search?q=      full-text search (FTS5) -> video ids
//   GET /api/sync/:id.json  time-synced track computed from manual anchors (src/admin.js recomputeSync)
//   GET /api/videos/:id/route.gpx       GPX of a manually edited route
//   GET /api/videos/:id/incyclist.zip   Incyclist package without video (concept 4.7), from Lokalisierungsstufe 3
//   GET /api/videos/:id/video2gpx-job.json  job for the desktop app video2gpx (VIDEO2GPX-INTEGRATION.md 8.1; nothing secret in it)
//   POST /api/videos/:id/wish           put a video on the wishlist for video2gpx (src/wishlist.js), same-origin only
//   GET /api/tracks                     GeoJSON of the routes uploaded as GPX in the admin and published (src/tracks.js)
//   GET /api/tracks/:id                 one published route with profile and its playable video assignments (route dialog)
//   GET /api/images/:imageId            preview image (R2) of a visible video
//   GET /api/videos/:id/package.zip     a ride's package without its video (Van Gestel, src/rides.js)
//   GET /api/ride/v1/catalog.json       the rides for the ridrs app (ridrs_app docs/formats/scenic-ride-catalog-v1.md)
//   GET /vg/:slug/…                     a ride's files of the build (thumbnail, overlay, package), only for visible videos
//   GET /lines.json, /gpx/:id.gpx, /sync/:id.json  static assets of the build, served only for visible videos
//   /admin, /api/admin/*    admin UI and API (phase 4), only with a verified Cloudflare Access identity (src/auth.js)
//   scheduled()             daily YouTube Data API refresh of every YouTube entry older than 29 days
// Everything else is served from dist/ (static assets). Visible = published in the admin (video.site_published), not hidden,
// public on YouTube and no channel opt-out; the pipeline's static files hold every video, so the worker filters them too.
import { adminIdentity, sameOriginWrite } from './auth.js';
import { basePath, routePath, VIDEO_ID } from './base.js';
import { FTS_INSERT } from './search-index.js';
import { packageZip, rideCatalog, ridePicture, slugOf, trackFacts } from './rides.js';
import { handleAdmin, HttpError, ajson, routeLine, loadTrack, loadJob } from './admin.js';
import { buildIncyclistZip, MIN_LEVEL } from './incyclist.js';
import { buildTrack } from '../site/lib/route-sync.js';
import { routeLines } from './route-lines.js';
import { vote } from './wishlist.js';
import { publicTracks, publicTrack } from './tracks.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const VISIBLE = "v.site_published = 1 AND v.hidden = 0 AND (v.status IS NULL OR v.status = 'public') AND NOT EXISTS (SELECT 1 FROM channel_optout o WHERE o.channel_id = v.channel_id)";
const ID = VIDEO_ID;

const json = (data, { status = 200, maxAge = 300 } = {}) =>
  new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, 'cache-control': `public, max-age=${maxAge}` } });
const parse = (s) => { try { return s == null ? null : JSON.parse(s); } catch { return null; } };

async function points(env) {
  const { results } = await env.DB.prepare(`
    SELECT v.video_id, v.title, COALESCE(c.name, so.author) AS channel, v.channel_id, v.lat, v.lon, v.region, v.place, v.view_count, v.duration_s,
           v.published_at, v.embeddable, v.projection, v.footage, v.vehicle, v.topics, v.stars, v.editors_pick,
           l.loc_level, t.max_height, t.fps, t.hdr, t.bitrate_kbps, r.distance_km, r.ascent_m, r.main_road_class, r.unpaved_share, (s.video_id IS NOT NULL) AS synced,
           v.country, v.country_name, v.source, (p.video_id IS NOT NULL) AS ride
    FROM video v
    LEFT JOIN channel c ON c.channel_id = v.channel_id
    LEFT JOIN source so ON so.source_id = v.source
    LEFT JOIN ride_package p ON p.video_id = v.video_id
    LEFT JOIN localization l ON l.video_id = v.video_id
    LEFT JOIN video_tech t ON t.video_id = v.video_id
    LEFT JOIN route r ON r.video_id = v.video_id
    LEFT JOIN route_sync s ON s.video_id = v.video_id
    WHERE ${VISIBLE} AND v.lat IS NOT NULL
    ORDER BY v.view_count DESC`).all();
  // Positional arrays keep the payload small; the field list travels with it. Country names (German,
  // Natural Earth) come once as a {code: name} map instead of per row.
  const fields = ['id', 'title', 'channel', 'lat', 'lon', 'region', 'place', 'views', 'dur', 'published', 'embeddable',
    'projection', 'footage', 'vehicle', 'topics', 'stars', 'pick', 'loc', 'height', 'fps', 'hdr', 'km', 'synced', 'country', 'kbps', 'cid', 'asc', 'road', 'unp', 'src', 'ride'];
  const countries = {};
  const rows = results.map((r) => {
    if (r.country && !countries[r.country]) countries[r.country] = r.country_name || r.country;
    return [r.video_id, r.title, r.channel, r.lat, r.lon, r.region, r.place, r.view_count, r.duration_s,
      r.published_at?.slice(0, 10) ?? null, r.embeddable, r.projection, r.footage, r.vehicle, parse(r.topics) ?? [], r.stars,
      r.editors_pick, r.loc_level, r.max_height, r.fps, r.hdr, r.distance_km, r.synced, r.country, r.bitrate_kbps, r.channel_id, r.ascent_m, r.main_road_class, r.unpaved_share, r.source, r.ride];
  });
  return json({ fields, rows, countries }, { maxAge: 600 });
}

async function video(env, id) {
  if (!ID.test(id)) return json({ error: 'bad id' }, { status: 400 });
  const v = await env.DB.prepare(`SELECT v.*, c.name AS channel_name, c.country AS channel_country, s.name AS source_name, s.author, s.url AS source_url,
      s.license_id, s.license_name, s.license_url FROM video v
    LEFT JOIN channel c ON c.channel_id = v.channel_id LEFT JOIN source s ON s.source_id = v.source WHERE v.video_id = ?1 AND ${VISIBLE}`).bind(id).first();
  if (!v) return json({ error: 'not found' }, { status: 404 });
  const [tech, route, sync, loc, roads, img, pkg, wish] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM video_tech WHERE video_id = ?1').bind(id),
    env.DB.prepare('SELECT * FROM route WHERE video_id = ?1').bind(id),
    env.DB.prepare('SELECT * FROM route_sync WHERE video_id = ?1').bind(id),
    env.DB.prepare('SELECT loc_level, loc_key, method, err_along_med_m, err_along_max_m, anchor_count, verified_at, rules_version FROM localization WHERE video_id = ?1').bind(id),
    env.DB.prepare('SELECT dim, value, share FROM route_road WHERE video_id = ?1 ORDER BY share DESC').bind(id),
    env.DB.prepare('SELECT image_id, width, height, rights, credit FROM video_image WHERE video_id = ?1 ORDER BY is_primary DESC, uploaded_at DESC LIMIT 1').bind(id),
    env.DB.prepare('SELECT * FROM ride_package WHERE video_id = ?1').bind(id),
    env.DB.prepare('SELECT votes FROM wish WHERE video_id = ?1').bind(id),
  ]);
  const level = loc.results[0]?.loc_level ?? 7, im = img.results[0], p = pkg.results[0];
  // A ride of a source with one author (Van Gestel): its page instead of YouTube, its picture, its package instead of a generated one.
  const picture = p && !im ? ridePicture(id, p) : null;
  const share = (dim) => Object.fromEntries(roads.results.filter((x) => x.dim === dim).map((x) => [x.value, x.share]));
  const t = tech.results[0], r = route.results[0];
  return json({
    id, url: p?.page_url ?? `https://www.youtube.com/watch?v=${id}`,
    title: v.title, channel: { id: v.channel_id, name: v.channel_name ?? v.author, country: v.channel_country },
    source: { id: v.source, name: v.source_name, author: v.author, url: v.source_url,
      license: v.license_id ? { id: v.license_id, name: v.license_name, url: v.license_url } : null },
    ride: p ? { tour: p.tour_name ? { name: p.tour_name, part: p.tour_part } : null, level: p.level, track_type: p.track_type, bike_type: p.bike_type,
      climbs: parse(p.climbs) ?? [], download_url: p.download_url, download_size: p.download_size } : null,
    published: v.published_at, duration_s: v.duration_s, views: v.view_count, likes: v.like_count,
    embeddable: !!v.embeddable, projection: v.projection, region_blocked: parse(v.region_blocked), region_allowed: parse(v.region_allowed),
    api_fetched_at: v.api_fetched_at,
    region: v.region, country: v.country, country_name: v.country_name, place: v.place, lat: v.lat, lon: v.lon, position_exact: !!v.position_exact,
    footage: v.footage, vehicle: v.vehicle, topics: parse(v.topics) ?? [],
    stars: v.stars, editor_note: v.editor_note, editors_pick: !!v.editors_pick,
    tech: t ? { ...t, codecs: parse(t.codecs) } : null,
    route: r ? { distance_km: r.distance_km, method: r.method, line: parse(r.polyline), gpx: r.gpx_path,
      elevation: r.ascent_m == null ? null : { ascent_m: r.ascent_m, descent_m: r.descent_m, min_ele_m: r.min_ele_m, max_ele_m: r.max_ele_m,
        max_gradient: r.max_gradient, profile: parse(r.profile), source: r.ele_source },
      roads: r.main_road_class == null ? null : { main_class: r.main_road_class, unpaved_share: r.unpaved_share, tunnel_km: r.tunnel_km,
        bridge_km: r.bridge_km, class_share: share('class'), surface_share: share('surface') },
      creator_links: parse(r.creator_links) ?? [], check: r.check_status ? { status: r.check_status, note: r.check_note } : null } : null,
    sync: sync.results[0] ?? null,
    localization: loc.results[0] ?? null,
    image: im ? { url: `api/images/${im.image_id}`, width: im.width, height: im.height, rights: im.rights, credit: im.credit }
      : picture ? { ...picture, width: null, height: null, rights: null, credit: v.author } : null,
    // Incyclist package (concept 4.7): from level 3 on; level 3 with a warning. A ride has its original package (without video).
    incyclist: p ? { available: true, level, warn: false, url: `api/videos/${id}/package.zip`, package: true }
      : { available: level <= MIN_LEVEL && !!(sync.results[0] || r), level, warn: level === MIN_LEVEL, url: `api/videos/${id}/incyclist.zip` },
    // Wishlist for video2gpx (src/wishlist.js): only a YouTube video without a secured track can be refined.
    wish: { refinable: v.source === 'youtube' && level > 2, votes: wish.results[0]?.votes ?? 0, url: `api/videos/${id}/wish` },
  });
}

async function search(env, q) {
  const terms = (q || '').normalize('NFKC').match(/[\p{L}\p{N}]+/gu)?.slice(0, 8) ?? [];
  if (!terms.length) return json({ ids: [] });
  const match = terms.map((t) => `"${t}"*`).join(' ');
  const { results } = await env.DB.prepare(`SELECT f.video_id FROM video_fts f JOIN video v ON v.video_id = f.video_id
    WHERE video_fts MATCH ?1 AND ${VISIBLE} ORDER BY rank LIMIT 500`).bind(match).all();
  return json({ ids: results.map((r) => r.video_id) }, { maxAge: 300 });
}

// --- YouTube Data API refresh (30-day rule, concept 1.1 and 4.4) ---

const iso = (d) => {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d || '');
  return m ? (+(m[1] || 0)) * 86400 + (+(m[2] || 0)) * 3600 + (+(m[3] || 0)) * 60 + (+(m[4] || 0)) : null;
};

async function youtube(env, endpoint, params) {
  const url = `https://www.googleapis.com/youtube/v3/${endpoint}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: { 'X-goog-api-key': env.YOUTUBE_API_KEY } });
  if (!res.ok) throw new Error(`YouTube API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export async function refresh(env, { limit = 1500 } = {}) {
  if (!env.YOUTUBE_API_KEY) throw new Error('YOUTUBE_API_KEY not set');
  const today = new Date().toISOString().slice(0, 10);
  const { results } = await env.DB.prepare(`SELECT video_id FROM video WHERE source = 'youtube' AND (api_fetched_at IS NULL OR api_fetched_at <= date('now', '-29 days'))
    ORDER BY api_fetched_at LIMIT ?1`).bind(limit).all();
  const ids = results.map((r) => r.video_id);
  let updated = 0, removed = 0;
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const data = await youtube(env, 'videos', { part: 'snippet,contentDetails,statistics,status', id: batch.join(','), maxResults: '50' });
    const got = new Map((data.items || []).map((it) => [it.id, it]));
    const stmts = [];
    for (const id of batch) {
      const it = got.get(id);
      if (!it) {
        // Gone or private: drop the API data, keep only the id (allowed indefinitely).
        stmts.push(env.DB.prepare(`UPDATE video SET status = 'removed', title = NULL, view_count = NULL, like_count = NULL, api_fetched_at = ?2 WHERE video_id = ?1`).bind(id, today));
        removed++; continue;
      }
      const sn = it.snippet, cd = it.contentDetails, st = it.statistics || {}, s = it.status, rr = cd.regionRestriction || {};
      stmts.push(env.DB.prepare(`UPDATE video SET channel_id = ?2, title = ?3, published_at = ?4, duration_s = ?5, view_count = ?6, like_count = ?7,
        definition = ?8, projection = ?9, embeddable = ?10, region_blocked = ?11, region_allowed = ?12, audio_language = ?13, status = ?14, api_fetched_at = ?15
        WHERE video_id = ?1`).bind(id, sn.channelId, sn.title, sn.publishedAt, iso(cd.duration), st.viewCount ? +st.viewCount : null,
        st.likeCount ? +st.likeCount : null, cd.definition, cd.projection, s.embeddable ? 1 : 0,
        rr.blocked ? JSON.stringify(rr.blocked) : null, rr.allowed ? JSON.stringify(rr.allowed) : null,
        sn.defaultAudioLanguage ?? null, s.privacyStatus, today));
      updated++;
    }
    await env.DB.batch(stmts);
  }
  const ch = await env.DB.prepare(`SELECT channel_id FROM channel WHERE api_fetched_at IS NULL OR api_fetched_at <= date('now', '-29 days') LIMIT 500`).all();
  const cids = ch.results.map((r) => r.channel_id);
  for (let i = 0; i < cids.length; i += 50) {
    const data = await youtube(env, 'channels', { part: 'snippet', id: cids.slice(i, i + 50).join(','), maxResults: '50' });
    await env.DB.batch((data.items || []).map((it) => env.DB.prepare('UPDATE channel SET name = ?2, country = ?3, api_fetched_at = ?4 WHERE channel_id = ?1')
      .bind(it.id, it.snippet.title, it.snippet.country ?? null, today)));
  }
  if (updated || removed) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM video_fts'),
      env.DB.prepare(FTS_INSERT),
    ]);
  }
  return { videos: ids.length, updated, removed, channels: cids.length };
}

/** Is the video publicly visible? (for the static per-video assets) */
const isVisible = (env, id) => env.DB.prepare(`SELECT 1 AS ok FROM video v WHERE v.video_id = ?1 AND ${VISIBLE}`).bind(id).first();

/** A static per-video asset (gpx/<id>.gpx, sync/<id>.json) of the build, only for a visible video. */
async function videoAsset(env, request, id) {
  if (!ID.test(id) || !(await isVisible(env, id))) return new Response('Not found', { status: 404 });
  return env.ASSETS.fetch(request);
}

/** lines.json ({id: delta line}, site/lib/lines.js) for the visible videos, with the lines set in the admin (src/route-lines.js). */
async function linesJson(env, request) {
  const asset = await env.ASSETS.fetch(request);
  if (!asset.ok) return asset;
  return json(await routeLines(env, await asset.json(), VISIBLE), { maxAge: 600 });
}

const LEVEL_NAME = { 1: 'Verifiziert', 2: 'Verankert', 3: 'Geschätzt synchron' };

/** Track computed from manual anchors (D1 sync_track). */
async function syncJson(env, id) {
  if (!ID.test(id)) return json({ error: 'bad id' }, { status: 400 });
  const r = await env.DB.prepare(`SELECT t.json, t.hash FROM sync_track t JOIN video v ON v.video_id = t.video_id WHERE t.video_id = ?1 AND ${VISIBLE}`).bind(id).first();
  if (!r) return json({ error: 'not found' }, { status: 404 });
  return new Response(r.json, { headers: { ...JSON_HEADERS, 'cache-control': 'public, max-age=300', etag: `"${r.hash}"` } });
}

const xmlEsc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
/** GPX of the stored route line (manual routes; the pipeline's GPX files are static assets). */
async function routeGpx(env, id) {
  if (!ID.test(id)) return json({ error: 'bad id' }, { status: 400 });
  const r = await env.DB.prepare(`SELECT r.polyline, r.method FROM route r JOIN video v ON v.video_id = r.video_id WHERE r.video_id = ?1 AND ${VISIBLE}`).bind(id).first();
  const line = parse(r?.polyline);
  if (!line?.length) return json({ error: 'not found' }, { status: 404 });
  const name = `ridrs Scenic route ${id}`;
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="ridrs-scenic" xmlns="http://www.topografix.com/GPX/1/1">
<metadata><name>${xmlEsc(name)}</name><desc>Route for https://www.youtube.com/watch?v=${id}, method ${xmlEsc(r.method)}. Geometry derived from OpenStreetMap data.</desc><copyright author="OpenStreetMap contributors"><year>${new Date().getUTCFullYear()}</year><license>https://opendatacommons.org/licenses/odbl/1-0/</license></copyright><link href="https://www.openstreetmap.org/copyright"><text>Map data © OpenStreetMap contributors (ODbL)</text></link></metadata>
<trk><name>${xmlEsc(name)}</name><trkseg>
${line.map(([la, lo]) => `<trkpt lat="${la}" lon="${lo}"></trkpt>`).join('\n')}
</trkseg></trk>
</gpx>
`;
  return new Response(gpx, { headers: { 'content-type': 'application/gpx+xml; charset=utf-8', 'cache-control': 'public, max-age=300',
    'content-disposition': `attachment; filename="${id}.gpx"` } });
}

/** The video2gpx job of a visible video (VIDEO2GPX-INTEGRATION.md 8.1); the admin has its own copy for hidden videos. */
async function video2gpxJob(env, id, origin) {
  if (!ID.test(id)) return json({ error: 'bad id' }, { status: 400 });
  const j = await loadJob(env, id, origin, { where: VISIBLE });
  if (!j) return json({ error: 'not found' }, { status: 404 });
  return new Response(JSON.stringify(j.job, null, 2) + '\n', { headers: { ...JSON_HEADERS, 'cache-control': 'public, max-age=60',
    'content-disposition': `attachment; filename="${id}.v2g.json"` } });
}

/** The package without its video of a visible ride (ADR 0095). */
async function packageResponse(env, id, request) {
  if (!ID.test(id)) return json({ error: 'bad id' }, { status: 400 });
  const row = await env.DB.prepare(`SELECT p.package, p.overlay, p.page_url, v.title, s.name AS source_name, s.author, s.license_name, s.license_url
    FROM ride_package p JOIN video v ON v.video_id = p.video_id LEFT JOIN source s ON s.source_id = v.source WHERE p.video_id = ?1 AND ${VISIBLE}`).bind(id).first();
  if (!row) return json({ error: 'not found' }, { status: 404 });
  const zip = await packageZip(env, row, `${new URL(request.url).origin}${basePath(env)}/vg/${slugOf(id)}`);
  return new Response(zip, { headers: { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${slugOf(id)}.zip"`,
    'cache-control': 'public, max-age=3600' } });
}

/** The ride catalog of the app, with an ETag of its body (304 for a client that has it). */
async function rideCatalogResponse(env, request, site) {
  const { results } = await env.DB.prepare(`SELECT v.video_id, v.title, v.country, v.duration_s, v.source, p.*, s.name AS source_name, s.author,
      s.url AS source_url, s.license_id, s.license_name, s.license_url
    FROM ride_package p JOIN video v ON v.video_id = p.video_id LEFT JOIN source s ON s.source_id = v.source WHERE ${VISIBLE} ORDER BY v.video_id`).all();
  // YouTube videos with an Incyclist package (from level MIN_LEVEL) and elevations, from their synced track or their
  // route's profile: the YouTube downloader of the app fetches the package and the video (ridrs_app ADR 0105).
  const { results: candidates } = await env.DB.prepare(`SELECT v.video_id, v.title, v.place, v.country, v.duration_s, v.source,
      c.name AS channel, t.fps, t.bitrate_kbps, r.distance_km, r.ascent_m, r.profile, rs.method AS sync_method,
      rs.path AS sync_path, s.name AS source_name, s.author, s.url AS source_url, s.license_id, s.license_name, s.license_url,
      (SELECT i.image_id FROM video_image i WHERE i.video_id = v.video_id ORDER BY i.is_primary DESC, i.uploaded_at DESC LIMIT 1) AS image_id
    FROM video v JOIN localization l ON l.video_id = v.video_id LEFT JOIN route r ON r.video_id = v.video_id
    LEFT JOIN route_sync rs ON rs.video_id = v.video_id LEFT JOIN channel c ON c.channel_id = v.channel_id
    LEFT JOIN video_tech t ON t.video_id = v.video_id LEFT JOIN source s ON s.source_id = v.source
    WHERE ${VISIBLE} AND v.source = 'youtube' AND l.loc_level <= ?1 AND v.duration_s > 0
      AND (rs.video_id IS NOT NULL OR (r.profile IS NOT NULL AND r.distance_km > 0)) ORDER BY v.video_id`).bind(MIN_LEVEL).all();
  const videos = [];
  for (const row of candidates) {
    const sync = row.sync_method ? { method: row.sync_method, path: row.sync_path } : null;
    const track = trackFacts(await loadTrack(env, row.video_id, sync, site).catch(() => null));
    if (track) videos.push({ ...row, track });
    else if (row.profile && row.distance_km > 0) videos.push(row);
  }
  const body = JSON.stringify(rideCatalog(results, site, videos));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(body)));
  const etag = `"${[...digest].map((b) => b.toString(16).padStart(2, '0')).join('')}"`;
  const headers = { ...JSON_HEADERS, 'cache-control': 'public, max-age=600', etag };
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
  return new Response(body, { headers });
}

async function imageResponse(env, iid) {
  if (!/^[0-9a-f]{24}$/.test(iid) || !env.IMAGES) return json({ error: 'not found' }, { status: 404 });
  const img = await env.DB.prepare(`SELECT i.r2_key, i.mime FROM video_image i JOIN video v ON v.video_id = i.video_id WHERE i.image_id = ?1 AND ${VISIBLE}`).bind(iid).first();
  const obj = img && (await env.IMAGES.get(img.r2_key));
  if (!obj) return json({ error: 'not found' }, { status: 404 });
  return new Response(obj.body, { headers: { 'content-type': img.mime, 'cache-control': 'public, max-age=86400, immutable' } });
}

/** Incyclist ZIP (concept 4.7), built on request; cached 24 h under a key that changes with track, image, fps and level. */
async function incyclist(env, id, request, ctx) {
  if (!ID.test(id)) return json({ error: 'bad id' }, { status: 400 });
  const origin = new URL(request.url).origin + basePath(env);
  const v = await env.DB.prepare(`SELECT v.video_id, v.title, v.place, v.region, v.country, v.duration_s, v.position_exact FROM video v WHERE v.video_id = ?1 AND ${VISIBLE}`).bind(id).first();
  if (!v) return json({ error: 'not found' }, { status: 404 });
  const [loc, sync, route, tech, img] = await env.DB.batch([
    env.DB.prepare('SELECT loc_level FROM localization WHERE video_id = ?1').bind(id),
    env.DB.prepare('SELECT * FROM route_sync WHERE video_id = ?1').bind(id),
    env.DB.prepare('SELECT * FROM route WHERE video_id = ?1').bind(id),
    env.DB.prepare('SELECT fps FROM video_tech WHERE video_id = ?1').bind(id),
    // Only an image we hold the rights to goes into the package (2.9); JPG first.
    env.DB.prepare("SELECT image_id, r2_key, mime, credit FROM video_image WHERE video_id = ?1 ORDER BY is_primary DESC, (mime = 'image/jpeg') DESC, uploaded_at DESC LIMIT 1").bind(id),
  ]);
  const level = loc.results[0]?.loc_level ?? 7;
  if (level > MIN_LEVEL) return json({ error: 'level', message: `Incyclist-Export erst ab Lokalisierungsstufe ${MIN_LEVEL}; dieses Video hat Stufe ${level}.` }, { status: 409, maxAge: 60 });
  const s = sync.results[0], r = route.results[0], fps = tech.results[0]?.fps ?? null, im = img.results[0];
  const key = new Request(`${origin}/api/videos/${id}/incyclist.zip?k=${[s?.hash ?? 'model', r?.built_at ?? '', im?.image_id ?? '', fps ?? '', level].join('-')}`);
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const hit = await cache?.match(key);
  if (hit) return hit;
  let track = await loadTrack(env, id, s, origin);
  if (!track && r) {
    // Level 3 without a stored track: start, end and the speed model over the whole video.
    const line = await routeLine(env, id, r, origin);
    track = line && buildTrack({ line, duration: v.duration_s, profile: parse(r.profile) })?.track;
  }
  if (!track?.t?.length) return json({ error: 'no track', message: 'Keine Zeitzuordnung vorhanden.' }, { status: 409, maxAge: 60 });
  let image = null;
  if (im && env.IMAGES) {
    const obj = await env.IMAGES.get(im.r2_key);
    if (obj) image = { ext: { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[im.mime] ?? 'jpg', bytes: new Uint8Array(await obj.arrayBuffer()), credit: im.credit };
  }
  const usePlace = v.place && v.place !== v.region && (v.position_exact || r);
  const { name, zip } = buildIncyclistZip({ videoId: id, title: v.title || v.place || id, country: v.country, place: usePlace ? v.place : null,
    track, profile: parse(r?.profile), fps, level, levelName: LEVEL_NAME[level], image });
  const res = new Response(zip, { headers: { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${name}.zip"`,
    'cache-control': 'public, max-age=86400' } });
  if (cache) ctx?.waitUntil?.(cache.put(key, res.clone()));
  return res;
}

const forbidden = (html) => html
  ? new Response('<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>403</title><p>Kein Zugang. Der Admin-Bereich ist nur über Cloudflare Access erreichbar.</p>',
    { status: 403, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' } })
  : ajson({ error: 'forbidden' }, 403);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url), base = basePath(env);
    const r = routePath(url.pathname, base);
    // Relative Location: correct behind ridrs.app (Service Binding) and on localhost alike.
    if (r.redirect) return new Response(null, { status: 302, headers: { location: `${r.redirect}${url.search}` } });
    if (r.outside) return new Response('Not found', { status: 404 });
    const p = r.path, site = url.origin + base; // site = what relative paths resolve against
    try {
      // Admin (concept 3.5): page and API only with a verified identity; never indexed.
      if (p.startsWith('/admin/')) {
        if (!(await adminIdentity(request, env))) return forbidden(true);
        const res = await env.ASSETS.fetch(request);
        const out = new Response(res.body, res);
        out.headers.set('x-robots-tag', 'noindex, nofollow');
        out.headers.set('cache-control', 'no-store');
        return out;
      }
      if (p.startsWith('/api/admin/')) {
        const who = await adminIdentity(request, env);
        if (!who) return forbidden(false);
        if (!sameOriginWrite(request)) return ajson({ error: 'cross-site request' }, 403);
        return await handleAdmin(request, env, who, ctx);
      }
      let m0, w = /^\/api\/videos\/([\w-]+)\/wish$/.exec(p);
      if (w && request.method === 'POST') {
        if (!ID.test(w[1])) return json({ error: 'bad id' }, { status: 400 });
        if (!sameOriginWrite(request)) return json({ error: 'cross-site request' }, { status: 403, maxAge: 0 });
        const res = await vote(env, request, w[1], VISIBLE);
        return json(res.body, { status: res.status, maxAge: 0 });
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'method not allowed' }, { status: 405 });
      if (p === '/api/points') return await points(env);
      if (p === '/api/tracks') return json(await publicTracks(env), { maxAge: 120 });
      if ((m0 = /^\/api\/tracks\/(\d+)$/.exec(p))) { const t = await publicTrack(env, m0[1], VISIBLE); return t ? json(t) : json({ error: 'not found' }, { status: 404 }); }
      if (p === '/api/search') return await search(env, url.searchParams.get('q'));
      let m = /^\/api\/videos\/([\w-]+)$/.exec(p);
      if (m) return await video(env, m[1]);
      if ((m = /^\/api\/videos\/([\w-]+)\/incyclist\.zip$/.exec(p))) return await incyclist(env, m[1], request, ctx);
      if ((m = /^\/api\/videos\/([\w-]+)\/route\.gpx$/.exec(p))) return await routeGpx(env, m[1]);
      if ((m = /^\/api\/videos\/([\w-]+)\/package\.zip$/.exec(p))) return await packageResponse(env, m[1], request);
      if (p === '/api/ride/v1/catalog.json') return await rideCatalogResponse(env, request, site);
      if ((m = /^\/api\/videos\/([\w-]+)\/video2gpx-job\.json$/.exec(p))) return await video2gpxJob(env, m[1], site);
      if ((m = /^\/api\/sync\/([\w-]+)\.json$/.exec(p))) return await syncJson(env, m[1]);
      if ((m = /^\/api\/images\/([\w-]+)$/.exec(p))) return await imageResponse(env, m[1]);
      if (p.startsWith('/api/')) return json({ error: 'not found' }, { status: 404 });
      if (p === '/lines.json') return await linesJson(env, request);
      if ((m = /^\/gpx\/([^/]+)\.gpx$/.exec(p)) || (m = /^\/sync\/([^/]+)\.json$/.exec(p))) return await videoAsset(env, request, m[1]);
      if (p.startsWith('/gpx/') || p.startsWith('/sync/')) return new Response('Not found', { status: 404 });
      if ((m = /^\/vg\/([a-z0-9-]+)\/./.exec(p))) return await videoAsset(env, request, `vg-${m[1]}`);
      if (p.startsWith('/vg/')) return new Response('Not found', { status: 404 });
    } catch (err) {
      if (err instanceof HttpError) return ajson({ ...err.extra, error: err.message }, err.status);
      console.error(err);
      return json({ error: 'internal error' }, { status: 500, maxAge: 0 });
    }
    return env.ASSETS.fetch(request);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refresh(env).then((r) => console.log('youtube refresh', JSON.stringify(r))));
  },
};
