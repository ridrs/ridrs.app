// SPDX-License-Identifier: AGPL-3.0-or-later
// Routes uploaded as GPX in the admin (tab „Routen“), not tied to a video (migrations/0010_tracks.sql).
//   admin   GET    /api/admin/tracks         all routes (with line)
//           POST   /api/admin/tracks         multipart: file (GPX), name, description, color, published
//           PATCH  /api/admin/tracks/<id>    {name, description, color, published}
//           DELETE /api/admin/tracks/<id>
//   public  GET    /api/tracks               GeoJSON of the published routes (src/worker.js), drawn by site/app.js in their colour
// Every write is logged in edit_log (entity „track“, video_id null); like images it cannot be undone from the log.
// The pure parts (parseGpx, simplify, lengthKm) are exported for test/tracks.test.mjs.

export const MAX_GPX_BYTES = 15 * 1024 * 1024;
/** Points kept per route after simplification: enough for a smooth line at zoom 14, small enough for /api/tracks. */
export const MAX_POINTS = 4000;
/** Default colour: magenta, apart from every level colour (--l1 … --l7) and the open video's route (--map-route). */
export const DEFAULT_COLOR = '#d6336c';
const COLOR = /^#[0-9a-f]{6}$/;

const XML_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : XML_ENT[e] ?? m))
  .trim();
const attr = (tag, name) => { const m = new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`).exec(tag); return m ? +m[1] : NaN; };

/**
 * GPX text -> {name, segments: [[[lon, lat], …], …], points}. Track segments first, else routes (rtept); waypoints alone are no route.
 * A regex reader, not a full XML parser (workers have no DOMParser): GPX from Strava, Komoot, Garmin, RideWithGPS and GPX Studio all
 * write plain <trkpt lat lon> elements.
 */
export function parseGpx(text) {
  if (typeof text !== 'string' || !/<gpx[\s>]/i.test(text)) throw new Error('Keine GPX-Datei');
  const pts = (body, tag) => [...body.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'g'))]
    .map((m) => [attr(m[0], 'lon'), attr(m[0], 'lat')])
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

/** GeoJSON geometry of a stored line. */
export const geometry = (segments) => (segments.length === 1 ? { type: 'LineString', coordinates: segments[0] } : { type: 'MultiLineString', coordinates: segments });

const text = (max) => (v) => { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, max) : null; };
const color = (v, fallback) => { const c = String(v ?? '').trim().toLowerCase(); return COLOR.test(c) ? c : fallback; };
const now = () => new Date().toISOString();
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
const row = (r) => r && ({ ...r, published: !!r.published, line: parse(r.line) });
const log = (env, id, old, next, who) => env.DB.prepare('INSERT INTO edit_log (video_id, entity, field, old, new, who, at) VALUES (NULL, ?1, ?2, ?3, ?4, ?5, ?6)')
  .bind('track', String(id), old ? JSON.stringify(summary(old)) : null, next ? JSON.stringify(summary(next)) : null, who, now());
// The log keeps the editable fields, not the line (up to 4000 points).
const summary = (t) => ({ name: t.name, description: t.description, color: t.color, published: !!t.published, distance_km: t.distance_km });

/** Admin handler for /api/admin/tracks[/<id>]; `fail(status, message)` throws the admin's HttpError. */
export async function tracksAdmin(env, who, method, id, request, fail) {
  if (id == null) {
    if (method === 'GET') {
      const { results } = await env.DB.prepare('SELECT * FROM track ORDER BY created_at DESC, track_id DESC').all();
      return results.map(row);
    }
    if (method === 'POST') return upload(env, who, request, fail);
    fail(405, 'Methode nicht erlaubt');
  }
  if (!/^\d+$/.test(id)) fail(400, 'Ungültige Routen-ID');
  const cur = row(await env.DB.prepare('SELECT * FROM track WHERE track_id = ?1').bind(+id).first());
  if (!cur) fail(404, 'Route nicht gefunden');
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
    await env.DB.batch([env.DB.prepare('DELETE FROM track WHERE track_id = ?1').bind(cur.track_id), log(env, cur.track_id, cur, null, who)]);
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
  const segments = simplify(gpx.segments);
  const at = now();
  const t = { name: text(200)(form.get('name')) ?? gpx.name ?? text(200)(String(file.name || '').replace(/\.gpx$/i, '')) ?? 'Route',
    description: text(2000)(form.get('description')), color: color(form.get('color'), DEFAULT_COLOR), published: form.get('published') === '1',
    line: segments, distance_km: Math.round(lengthKm(gpx.segments) * 100) / 100, points_in: gpx.points, file_name: text(200)(file.name),
    created_by: who, created_at: at, updated_at: at };
  const ins = await env.DB.prepare(`INSERT INTO track (name, description, color, published, line, distance_km, points_in, file_name, created_by, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`)
    .bind(t.name, t.description, t.color, t.published ? 1 : 0, JSON.stringify(segments), t.distance_km, t.points_in, t.file_name, who, at, at).run();
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
