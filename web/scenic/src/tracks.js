// SPDX-License-Identifier: AGPL-3.0-or-later
// Routes uploaded as GPX in the admin (tab „Routen“), not tied to a video (migrations/0010_tracks.sql).
//   admin   GET    /api/admin/tracks         all routes (with line)
//           POST   /api/admin/tracks         multipart: file (GPX), name, description, color, published
//           PATCH  /api/admin/tracks/<id>    {name, description, color, published}
//           DELETE /api/admin/tracks/<id>
//   route editor (site/admin/route-editor.js, migration 0011):
//           GET    /api/admin/tracks/<id>             the route with its profile, its video assignments and their videos
//           PUT    /api/admin/tracks/<id>/videos      {segments: [{from_km, video_id, t_from_s, t_to_s}, …]} replaces the assignments
//           POST   /api/admin/tracks/<id>/candidates  {ids: [...]} title, channel, level, sync of the videos the editor found along the route
//           POST   /api/admin/tracks/<id>/elevation   profile from Open-Meteo, for a GPX without heights
//   public  GET    /api/tracks               GeoJSON of the published routes (src/worker.js), drawn by site/app.js in their colour
// Every write is logged in edit_log (entity „track“, video_id null); like images it cannot be undone from the log.
// The pure parts (parseGpx, simplify, lengthKm, profileOf) are exported for test/tracks.test.mjs.
import { kmAlong, pointAt } from '../site/lib/route-sync.js';
import { joinSegments } from '../site/lib/track-cover.js';
import { VIDEO_ID } from './base.js';

export const MAX_GPX_BYTES = 15 * 1024 * 1024;
/** Points kept per route after simplification: enough for a smooth line at zoom 14, small enough for /api/tracks. */
export const MAX_POINTS = 4000;
/** Default colour: magenta, apart from every level colour (--l1 … --l7) and the open video's route (--map-route). */
export const DEFAULT_COLOR = '#d6336c';
const COLOR = /^#[0-9a-f]{6}$/;
/** Points of a route's elevation profile at most. */
export const MAX_PROFILE = 1000;
/** Elevation lookup for a GPX without heights (Copernicus DEM, 90 m; no key; coordinates only). */
export const OPEN_METEO = 'https://api.open-meteo.com/v1/elevation';

const XML_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : XML_ENT[e] ?? m))
  .trim();
const attr = (tag, name) => { const m = new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`).exec(tag); return m ? +m[1] : NaN; };

/**
 * GPX text -> {name, segments: [[[lon, lat] or [lon, lat, ele], …], …], points}. Track segments first, else routes (rtept); waypoints alone are no route.
 * A regex reader, not a full XML parser (workers have no DOMParser): GPX from Strava, Komoot, Garmin, RideWithGPS and GPX Studio all
 * write plain <trkpt lat lon> elements.
 */
export function parseGpx(text) {
  if (typeof text !== 'string' || !/<gpx[\s>]/i.test(text)) throw new Error('Keine GPX-Datei');
  const pts = (body, tag) => [...body.matchAll(new RegExp(`<${tag}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${tag}>)`, 'g'))]
    .map((m) => {
      const lo = attr(` ${m[1]}`, 'lon'), la = attr(` ${m[1]}`, 'lat'), e = /<ele>\s*([-+\d.eE]+)\s*<\/ele>/.exec(m[2] ?? '');
      return e && Number.isFinite(+e[1]) ? [lo, la, +e[1]] : [lo, la];
    })
    .filter(([lo, la]) => Number.isFinite(lo) && Number.isFinite(la) && Math.abs(la) <= 90 && Math.abs(lo) <= 180);
  let segments = [...text.matchAll(/<trkseg\b[^>]*>([\s\S]*?)<\/trkseg>/g)].map((m) => pts(m[1], 'trkpt'));
  if (!segments.some((s) => s.length > 1)) segments = [...text.matchAll(/<rte\b[^>]*>([\s\S]*?)<\/rte>/g)].map((m) => pts(m[1], 'rtept'));
  segments = segments.filter((s) => s.length > 1);
  if (!segments.length) throw new Error('Die GPX-Datei enthält keinen Track und keine Route mit mindestens zwei Punkten');
  const nm = /<trk\b[^>]*>[\s\S]*?<name>([\s\S]*?)<\/name>/.exec(text) ?? /<rte\b[^>]*>[\s\S]*?<name>([\s\S]*?)<\/name>/.exec(text)
    ?? /<metadata\b[^>]*>[\s\S]*?<name>([\s\S]*?)<\/name>/.exec(text);
  return { name: nm ? unxml(nm[1]).slice(0, 200) || null : null, segments, points: segments.reduce((n, s) => n + s.length, 0) };
}

const R = 6371.0088;
const rad = Math.PI / 180;
function hav([lo1, la1], [lo2, la2]) {
  const a = Math.sin(((la2 - la1) * rad) / 2) ** 2 + Math.cos(la1 * rad) * Math.cos(la2 * rad) * Math.sin(((lo2 - lo1) * rad) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
/** Length of all segments in km. */
export const lengthKm = (segments) => segments.reduce((sum, s) => s.reduce((d, p, i) => (i ? d + hav(s[i - 1], p) : d), sum), 0);

// Douglas–Peucker on a local equirectangular projection (metres), iterative to stay off the call stack for long tracks.
function dp(line, tolM) {
  if (line.length < 3) return line;
  const k = Math.cos(line[0][1] * rad) * 111320, xy = line.map(([lo, la]) => [lo * k, la * 110540]);
  const keep = new Uint8Array(line.length); keep[0] = keep[line.length - 1] = 1;
  const stack = [[0, line.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = xy[a], [bx, by] = xy[b], dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    let worst = -1, at = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = xy[i];
      const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
      const d = Math.hypot(px - ax - t * dx, py - ay - t * dy);
      if (d > worst) { worst = d; at = i; }
    }
    if (worst > tolM) { keep[at] = 1; stack.push([a, at], [at, b]); }
  }
  return line.filter((_, i) => keep[i]);
}
/** Segments simplified (tolerance from 2 m, doubled until at most maxPoints remain), coordinates rounded to 5 decimals (~1 m). */
export function simplify(segments, maxPoints = MAX_POINTS) {
  const round = (s) => s.map(([lo, la]) => [Math.round(lo * 1e5) / 1e5, Math.round(la * 1e5) / 1e5]);
  let tol = 2, out;
  do { out = segments.map((s) => dp(s, tol)); tol *= 2; } while (out.reduce((n, s) => n + s.length, 0) > maxPoints && tol < 1e5);
  return out.map(round);
}

/**
 * Elevation profile [[km, ele], …] of the raw GPX points with heights, its km scaled onto the stored (simplified) line so they match
 * the editor's km; averaged into at most maxPoints bins. Null below two heights.
 */
export function profileOf(rawSegments, storedSegments, maxPoints = MAX_PROFILE) {
  const raw = joinSegmentsEle(rawSegments);
  if (raw.filter((p) => Number.isFinite(p[2])).length < 2) return null;
  const cum = kmAlong(raw), line = joinSegments(storedSegments), total = line.length > 1 ? kmAlong(line).at(-1) : 0;
  const scale = cum.at(-1) ? total / cum.at(-1) : 0;
  const pts = raw.map((p, i) => [cum[i] * scale, p[2]]).filter(([, e]) => Number.isFinite(e));
  const w = total / (maxPoints - 1), bins = new Map();
  for (const [km, e] of pts) { const b = pts.length > maxPoints && w ? Math.round(km / w) : km; const x = bins.get(b) ?? [0, 0, 0]; bins.set(b, [x[0] + km, x[1] + e, x[2] + 1]); }
  return [...bins.values()].map(([k, e, n]) => [Math.round((k / n) * 1000) / 1000, Math.round((e / n) * 10) / 10]);
}
const joinSegmentsEle = (segments) => segments.flat();

/** GeoJSON geometry of a stored line. */
export const geometry = (segments) => (segments.length === 1 ? { type: 'LineString', coordinates: segments[0] } : { type: 'MultiLineString', coordinates: segments });

const text = (max) => (v) => { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, max) : null; };
const color = (v, fallback) => { const c = String(v ?? '').trim().toLowerCase(); return COLOR.test(c) ? c : fallback; };
const now = () => new Date().toISOString();
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
const row = (r) => r && ({ ...r, published: !!r.published, line: parse(r.line), profile: parse(r.profile) });
const log = (env, id, old, next, who) => env.DB.prepare('INSERT INTO edit_log (video_id, entity, field, old, new, who, at) VALUES (NULL, ?1, ?2, ?3, ?4, ?5, ?6)')
  .bind('track', String(id), old ? JSON.stringify(summary(old)) : null, next ? JSON.stringify(summary(next)) : null, who, now());
// The log keeps the editable fields, not the line (up to 4000 points).
const summary = (t) => ({ name: t.name, description: t.description, color: t.color, published: !!t.published, distance_km: t.distance_km });

/** Admin handler for /api/admin/tracks[/<id>]; `fail(status, message)` throws the admin's HttpError. */
export async function tracksAdmin(env, who, method, id, request, fail) {
  if (id == null) {
    if (method === 'GET') {
      const { results } = await env.DB.prepare(`SELECT t.*, (SELECT count(DISTINCT v.video_id) FROM track_video v WHERE v.track_id = t.track_id) AS videos
        FROM track t ORDER BY t.created_at DESC, t.track_id DESC`).all();
      // the list leaves the profile out (up to 1000 points each); the editor reads it with GET tracks/<id>
      return results.map(row).map(({ profile, ...t }) => ({ ...t, has_profile: !!profile }));
    }
    if (method === 'POST') return upload(env, who, request, fail);
    fail(405, 'Methode nicht erlaubt');
  }
  if (!/^\d+$/.test(id)) fail(400, 'Ungültige Routen-ID');
  const cur = row(await env.DB.prepare('SELECT * FROM track WHERE track_id = ?1').bind(+id).first());
  if (!cur) fail(404, 'Route nicht gefunden');
  if (method === 'GET') return detail(env, cur);
  if (method === 'PATCH') {
    const body = await request.json().catch(() => fail(400, 'JSON erwartet'));
    const next = { ...cur };
    if ('name' in body) next.name = text(200)(body.name) ?? fail(400, 'Name fehlt');
    if ('description' in body) next.description = text(2000)(body.description);
    if ('color' in body) next.color = color(body.color, null) ?? fail(400, 'Farbe als #rrggbb');
    if ('published' in body) next.published = !!body.published;
    next.updated_at = now();
    await env.DB.batch([
      env.DB.prepare('UPDATE track SET name = ?2, description = ?3, color = ?4, published = ?5, updated_at = ?6 WHERE track_id = ?1')
        .bind(cur.track_id, next.name, next.description, next.color, next.published ? 1 : 0, next.updated_at),
      log(env, cur.track_id, cur, next, who),
    ]);
    return next;
  }
  if (method === 'DELETE') {
    await env.DB.batch([env.DB.prepare('DELETE FROM track_video WHERE track_id = ?1').bind(cur.track_id),
      env.DB.prepare('DELETE FROM track WHERE track_id = ?1').bind(cur.track_id), log(env, cur.track_id, cur, null, who)]);
    return { deleted: cur.track_id };
  }
  fail(405, 'Methode nicht erlaubt');
}

async function upload(env, who, request, fail) {
  if ((+request.headers.get('content-length') || 0) > MAX_GPX_BYTES + 64 * 1024) fail(413, 'Höchstens 15 MB');
  const form = await request.formData().catch(() => fail(400, 'Formular erwartet'));
  const file = form.get('file');
  if (!file || typeof file === 'string') fail(400, 'GPX-Datei fehlt');
  if (file.size > MAX_GPX_BYTES) fail(413, 'Höchstens 15 MB');
  let gpx;
  try { gpx = parseGpx(await file.text()); } catch (err) { fail(415, err.message); }
  const segments = simplify(gpx.segments), profile = profileOf(gpx.segments, segments);
  const at = now();
  const t = { name: text(200)(form.get('name')) ?? gpx.name ?? text(200)(String(file.name || '').replace(/\.gpx$/i, '')) ?? 'Route',
    description: text(2000)(form.get('description')), color: color(form.get('color'), DEFAULT_COLOR), published: form.get('published') === '1',
    line: segments, distance_km: Math.round(lengthKm(gpx.segments) * 100) / 100, points_in: gpx.points, file_name: text(200)(file.name),
    created_by: who, created_at: at, updated_at: at, has_profile: !!profile, ele_source: profile ? 'gpx' : null, videos: 0 };
  const ins = await env.DB.prepare(`INSERT INTO track (name, description, color, published, line, distance_km, points_in, file_name, created_by, created_at, updated_at,
    profile, ele_source) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`)
    .bind(t.name, t.description, t.color, t.published ? 1 : 0, JSON.stringify(segments), t.distance_km, t.points_in, t.file_name, who, at, at,
      profile ? JSON.stringify(profile) : null, t.ele_source).run();
  t.track_id = ins.meta?.last_row_id;
  await log(env, t.track_id, null, t, who).run();
  return t;
}

/** GeoJSON FeatureCollection of the published routes, for the public map. */
export async function publicTracks(env) {
  const { results } = await env.DB.prepare('SELECT track_id, name, description, color, line, distance_km FROM track WHERE published = 1 ORDER BY created_at').all();
  return { type: 'FeatureCollection', features: results.map((r) => ({ type: 'Feature', id: r.track_id, geometry: geometry(parse(r.line) ?? []),
    properties: { id: r.track_id, name: r.name, description: r.description, color: r.color, km: r.distance_km } })) };
}

/**
 * One published route for the public route dialog (site/route.js): line, profile and the video assignments the public page can play.
 * An assignment plays only with a visible (`visible`: the worker's SQL condition on alias v), embeddable video that has a synced track
 * and video seconds at both ends; every other one becomes a gap (video_id null), and neighbouring gaps are merged. The segments start
 * at km 0 (a gap before the first assignment). `videos` lists every visible assigned video, playable or not, for the dialog's list.
 * Null when the route does not exist or is not published.
 */
export async function publicTrack(env, id, visible) {
  if (!/^\d+$/.test(String(id))) return null;
  const t = await env.DB.prepare('SELECT track_id, name, description, color, line, profile, distance_km FROM track WHERE track_id = ?1 AND published = 1')
    .bind(+id).first();
  if (!t) return null;
  const line = parse(t.line) ?? [];
  const segs = await assignments(env, t.track_id);
  const ids = [...new Set(segs.map((s) => s.video_id).filter(Boolean))];
  const { results } = ids.length ? await env.DB.prepare(`SELECT v.video_id, v.title, c.name AS channel, v.duration_s, v.embeddable, l.loc_level,
      s.path AS sync_path, s.method AS sync_method
    FROM video v LEFT JOIN channel c ON c.channel_id = v.channel_id LEFT JOIN localization l ON l.video_id = v.video_id
    LEFT JOIN route_sync s ON s.video_id = v.video_id
    WHERE v.video_id IN (SELECT value FROM json_each(?1)) AND ${visible}`).bind(JSON.stringify(ids)).all() : { results: [] };
  const videos = results.map((v) => ({ id: v.video_id, title: v.title, channel: v.channel, duration_s: v.duration_s, embeddable: !!v.embeddable,
    loc_level: v.loc_level ?? 7, sync: v.sync_method ? { method: v.sync_method, path: v.sync_path } : null }));
  const byId = new Map(videos.map((v) => [v.id, v]));
  const playable = (s) => { const v = byId.get(s.video_id); return !!(v?.embeddable && v.sync && s.t_from_s != null && s.t_to_s != null && s.t_to_s > s.t_from_s); };
  const out = [];
  for (const s of segs) {
    const x = playable(s) ? { from_km: s.from_km, video_id: s.video_id, t_from_s: s.t_from_s, t_to_s: s.t_to_s }
      : { from_km: s.from_km, video_id: null, t_from_s: null, t_to_s: null };
    if (!x.video_id && out.length && !out.at(-1).video_id) continue;
    out.push(x);
  }
  if (!out.length || out[0].from_km > 0) out.unshift({ from_km: 0, video_id: null, t_from_s: null, t_to_s: null });
  if (out.length > 1 && !out[0].video_id && !out[1].video_id) out.splice(1, 1);
  const used = new Set(segs.map((s) => s.video_id));
  return { id: t.track_id, name: t.name, description: t.description, color: t.color, line, profile: parse(t.profile),
    km: trackKm(line), distance_km: t.distance_km, segments: out,
    videos: videos.filter((v) => used.has(v.id)).map((v) => ({ ...v, playable: out.some((s) => s.video_id === v.id) })) };
}

// --- route editor (site/admin/route-editor.js) ---

const VIDEO_META = `SELECT v.video_id, v.title, c.name AS channel, v.duration_s, v.embeddable, v.site_published, v.hidden, v.source, v.status,
    l.loc_level, s.method AS sync_method, r.distance_km
  FROM video v LEFT JOIN channel c ON c.channel_id = v.channel_id LEFT JOIN localization l ON l.video_id = v.video_id
  LEFT JOIN route_sync s ON s.video_id = v.video_id LEFT JOIN route r ON r.video_id = v.video_id
  WHERE v.video_id IN (SELECT value FROM json_each(?1))`;
async function videoMeta(env, ids) {
  if (!ids.length) return [];
  const { results } = await env.DB.prepare(VIDEO_META).bind(JSON.stringify(ids)).all();
  return results.map((r) => ({ ...r, synced: !!r.sync_method, embeddable: r.embeddable == null ? null : !!r.embeddable }));
}
const assignments = async (env, id) => (await env.DB.prepare('SELECT from_km, video_id, t_from_s, t_to_s FROM track_video WHERE track_id = ?1 ORDER BY from_km')
  .bind(id).all()).results;
/** km of the stored line, as the editor measures them. */
export const trackKm = (segments) => { const line = joinSegments(segments ?? []); return line.length > 1 ? kmAlong(line).at(-1) : 0; };

async function detail(env, cur) {
  const segs = await assignments(env, cur.track_id);
  return { ...cur, km: trackKm(cur.line), segments: segs, videos: await videoMeta(env, [...new Set(segs.map((s) => s.video_id).filter(Boolean))]) };
}

/** Admin handler for /api/admin/tracks/<id>/<sub>. */
export async function trackSub(env, who, method, id, sub, request, fail) {
  if (!/^\d+$/.test(id)) fail(400, 'Ungültige Routen-ID');
  const cur = row(await env.DB.prepare('SELECT * FROM track WHERE track_id = ?1').bind(+id).first());
  if (!cur) fail(404, 'Route nicht gefunden');
  const body = method === 'POST' || method === 'PUT' ? await request.json().catch(() => fail(400, 'JSON erwartet')) : null;
  if (sub === 'videos' && method === 'PUT') return putAssignments(env, who, cur, body, fail);
  if (sub === 'candidates' && method === 'POST') {
    const ids = Array.isArray(body?.ids) ? [...new Set(body.ids.filter((x) => typeof x === 'string' && VIDEO_ID.test(x)))] : fail(400, 'ids als Liste');
    if (ids.length > 2000) fail(400, 'Höchstens 2000 Videos');
    return videoMeta(env, ids);
  }
  if (sub === 'elevation' && method === 'POST') return lookupElevation(env, who, cur, fail);
  fail(405, 'Methode nicht erlaubt');
}

async function putAssignments(env, who, cur, body, fail) {
  const list = body?.segments;
  if (!Array.isArray(list) || list.length > 5000) fail(400, 'segments als Liste');
  const total = trackKm(cur.line), sec = (v) => (v == null ? null : Number.isFinite(+v) && +v >= 0 ? Math.round(+v * 10) / 10 : fail(400, 'Videozeit in Sekunden'));
  const next = list.map((x) => {
    const km = +x?.from_km;
    if (!Number.isFinite(km) || km < 0 || km > total + 0.01) fail(400, `from_km zwischen 0 und ${total.toFixed(2)}`);
    if (x.video_id != null && !VIDEO_ID.test(String(x.video_id))) fail(400, 'Ungültige Video-ID');
    return { from_km: Math.round(km * 1000) / 1000, video_id: x.video_id ?? null, t_from_s: sec(x.t_from_s), t_to_s: sec(x.t_to_s) };
  });
  for (let i = 1; i < next.length; i++) if (next[i].from_km <= next[i - 1].from_km) fail(400, 'from_km aufsteigend und verschieden');
  const ids = [...new Set(next.map((x) => x.video_id).filter(Boolean))];
  const known = new Set((await videoMeta(env, ids)).map((v) => v.video_id));
  const unknown = ids.find((v) => !known.has(v));
  if (unknown) fail(400, `Unbekanntes Video ${unknown}`);
  const old = await assignments(env, cur.track_id);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM track_video WHERE track_id = ?1').bind(cur.track_id),
    ...next.map((x) => env.DB.prepare('INSERT INTO track_video (track_id, from_km, video_id, t_from_s, t_to_s) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(cur.track_id, x.from_km, x.video_id, x.t_from_s, x.t_to_s)),
    env.DB.prepare('INSERT INTO edit_log (video_id, entity, field, old, new, who, at) VALUES (NULL, ?1, ?2, ?3, ?4, ?5, ?6)')
      .bind('track_video', String(cur.track_id), JSON.stringify(old.map((x) => [x.from_km, x.video_id])), JSON.stringify(next.map((x) => [x.from_km, x.video_id])), who, now()),
  ]);
  return { segments: next };
}

/** Profile from Open-Meteo every 100 m (at most 300 points, 100 per request) for a route whose GPX has no heights. */
async function lookupElevation(env, who, cur, fail) {
  const line = joinSegments(cur.line), cum = kmAlong(line), total = cum.at(-1);
  const n = Math.min(300, Math.max(2, Math.ceil(total / 0.1) + 1));
  const pts = Array.from({ length: n }, (_, i) => { const km = (total * i) / (n - 1); return [km, pointAt(line, cum, km)]; });
  const ele = [];
  for (let i = 0; i < n; i += 100) {
    const part = pts.slice(i, i + 100);
    const q = `latitude=${part.map(([, p]) => p[1].toFixed(5)).join(',')}&longitude=${part.map(([, p]) => p[0].toFixed(5)).join(',')}`;
    const res = await fetch(`${OPEN_METEO}?${q}`).catch(() => null);
    const data = res?.ok ? await res.json().catch(() => null) : null;
    if (!Array.isArray(data?.elevation) || data.elevation.length !== part.length) fail(502, 'Höhen von Open-Meteo nicht erhalten');
    ele.push(...data.elevation);
  }
  const profile = pts.map(([km], i) => [Math.round(km * 1000) / 1000, Math.round(+ele[i] * 10) / 10]).filter(([, e]) => Number.isFinite(e));
  await env.DB.batch([
    env.DB.prepare("UPDATE track SET profile = ?2, ele_source = 'open_meteo', updated_at = ?3 WHERE track_id = ?1").bind(cur.track_id, JSON.stringify(profile), now()),
    env.DB.prepare('INSERT INTO edit_log (video_id, entity, field, old, new, who, at) VALUES (NULL, ?1, ?2, NULL, ?3, ?4, ?5)')
      .bind('track', String(cur.track_id), JSON.stringify({ profile: 'open_meteo', points: profile.length }), who, now()),
  ]);
  return { profile, ele_source: 'open_meteo' };
}
