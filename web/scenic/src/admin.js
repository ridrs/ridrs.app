// SPDX-License-Identifier: AGPL-3.0-or-later
// Admin API (CLOUDFLARE-KONZEPT.md 3.5, phase 4 "Redaktion"). Every route needs an admin identity
// (src/auth.js); without one the answer is 403. Every write goes through change(): it reads the current
// state, writes the new one and records both in edit_log in the same D1 batch (= one transaction), so any
// single edit can be undone by writing its old state back (undo is itself logged and undoable).
//
// Fields the pipeline also writes (place, region, pin, country, route, localization, sync) get a row in
// manual_field; scripts/import.mjs never overwrites those ("manual fields always win").
import { basePath, VIDEO_ID } from './base.js';
import { FTS_INSERT } from './search-index.js';
import { buildTrack, anchorLevel, evaluateReview, kmAlong, project, LOC_RULES, KEYS } from '../site/lib/route-sync.js';
import { sniffImage, contentId, MAX_IMAGE_BYTES, RIGHTS } from './images.js';
import { buildJob, validateResult, resultMeta, routeAgreement, uploadLevel, MAX_RESULT_BYTES, ROUTE_OFFER_M } from './video2gpx.js';

export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const bad = (msg) => { throw new HttpError(400, msg); };
const ID = VIDEO_ID;
const now = () => new Date().toISOString();
const parse = (s) => { try { return s == null ? null : JSON.parse(s); } catch { return null; } };
const J = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
// Compares states by value: keys sorted, null and undefined members dropped (a DB row has every column, a built one not).
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().filter((k) => v[k] != null).map((k) => [k, canon(v[k])])) : v ?? null);
export const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
export const ajson = (data, status = 200) => new Response(JSON.stringify(data), { status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' } });

// localization_log has PRIMARY KEY (video_id, at): several level changes in one request need distinct times.
let seq = 0;
const stamp = () => now().replace('Z', `${String(seq++ % 1000).padStart(3, '0')}Z`);
const locLog = (env, id, from, to, reason) => env.DB.prepare('INSERT OR IGNORE INTO localization_log (video_id, at, from_level, to_level, reason) VALUES (?1, ?2, ?3, ?4, ?5)')
  .bind(id, stamp(), from ?? null, to ?? null, reason);
const mark = (env, id, field, who) => env.DB.prepare('INSERT OR REPLACE INTO manual_field (video_id, field, who, at) VALUES (?1, ?2, ?3, ?4)').bind(id, field, who, now());
const unmark = (env, id, field) => env.DB.prepare('DELETE FROM manual_field WHERE video_id = ?1 AND field = ?2').bind(id, field);
const isManual = async (env, id, field) => !!(await env.DB.prepare('SELECT 1 FROM manual_field WHERE video_id = ?1 AND field = ?2').bind(id, field).first());

// --- state handlers: get(env, video_id, field) -> value; set(env, video_id, field, value, who) -> statements ---

const str = (max) => (v) => { if (v == null || v === '') return null; if (typeof v !== 'string') bad('Text erwartet'); return v.trim().slice(0, max) || null; };
// Video columns the admin edits. manual = the pipeline writes it too, so it gets a manual_field row.
export const VIDEO_FIELDS = {
  stars: { cols: ['stars'], parse: (v) => { if (v == null || v === '' || v === 0) return null; const n = +v; if (!Number.isInteger(n) || n < 1 || n > 5) bad('Sterne 1–5'); return n; } },
  editors_pick: { cols: ['editors_pick'], parse: (v) => (v ? 1 : 0) },
  editor_note: { cols: ['editor_note'], parse: str(2000) },
  hidden: { cols: ['hidden'], parse: (v) => (v ? 1 : 0) },
  // Shown on the public site (migrations/0006_site_published.sql); not in the import, so it is not a manual field.
  site_published: { cols: ['site_published'], parse: (v) => (v ? 1 : 0) },
  place: { cols: ['place'], manual: true, parse: str(200) },
  region: { cols: ['region'], manual: true, parse: str(80) },
  country: { cols: ['country', 'country_name'], manual: true, parse: (v) => {
    const code = v?.country ? String(v.country).toUpperCase() : null;
    if (code && !/^[A-Z]{2}$/.test(code)) bad('Ländercode: zwei Buchstaben (ISO 3166-1)');
    return { country: code, country_name: code ? str(80)(v.country_name) ?? code : null };
  } },
  pin: { cols: ['lat', 'lon', 'position_exact'], manual: true, parse: (v) => {
    const lat = +v?.lat, lon = +v?.lon;
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) bad('Ungültige Koordinaten');
    return { lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6, position_exact: 1 };
  } },
};
const one = (spec) => spec.cols.length === 1;

const H = {
  video: {
    async get(env, id, field) {
      const spec = VIDEO_FIELDS[field];
      const row = await env.DB.prepare(`SELECT ${spec.cols.join(', ')} FROM video WHERE video_id = ?1`).bind(id).first();
      if (!row) throw new HttpError(404, 'Video nicht gefunden');
      const value = one(spec) ? row[spec.cols[0]] : Object.fromEntries(spec.cols.map((c) => [c, row[c]]));
      return spec.manual ? { value, manual: await isManual(env, id, spec.cols[0]) } : { value };
    },
    set(env, id, field, v, who) {
      const spec = VIDEO_FIELDS[field];
      const vals = one(spec) ? [v.value] : spec.cols.map((c) => v.value?.[c] ?? null);
      const out = [env.DB.prepare(`UPDATE video SET ${spec.cols.map((c, i) => `${c} = ?${i + 2}`).join(', ')}, updated_at = date('now') WHERE video_id = ?1`).bind(id, ...vals)];
      if (spec.manual) for (const c of spec.cols) out.push(v.manual ? mark(env, id, c, who) : unmark(env, id, c));
      if (field === 'place' || field === 'region') {
        out.push(env.DB.prepare('DELETE FROM video_fts WHERE video_id = ?1').bind(id),
          env.DB.prepare(`${FTS_INSERT} WHERE v.video_id = ?1`).bind(id));
      }
      return out;
    },
  },
  // field = video second as text; value = {lon, lat, source} or null (no anchor at that second)
  anchor: {
    async get(env, id, field) {
      const r = await env.DB.prepare('SELECT lon, lat, source FROM sync_anchor WHERE video_id = ?1 AND video_t_s = ?2').bind(id, +field).first();
      return r ? { ...r } : null;
    },
    set(env, id, field, v) {
      return [v ? env.DB.prepare('INSERT OR REPLACE INTO sync_anchor (video_id, video_t_s, lon, lat, source) VALUES (?1, ?2, ?3, ?4, ?5)').bind(id, +field, v.lon, v.lat, v.source || 'manual')
        : env.DB.prepare('DELETE FROM sync_anchor WHERE video_id = ?1 AND video_t_s = ?2').bind(id, +field)];
    },
  },
  // The whole route with its road shares, the localization row and both manual flags (a route edit changes the level).
  route: {
    async get(env, id) {
      const [r, roads, loc, mr, ml] = await env.DB.batch([
        env.DB.prepare('SELECT * FROM route WHERE video_id = ?1').bind(id),
        env.DB.prepare('SELECT dim, value, share, source FROM route_road WHERE video_id = ?1').bind(id),
        env.DB.prepare('SELECT * FROM localization WHERE video_id = ?1').bind(id),
        env.DB.prepare("SELECT 1 FROM manual_field WHERE video_id = ?1 AND field = 'route'").bind(id),
        env.DB.prepare("SELECT 1 FROM manual_field WHERE video_id = ?1 AND field = 'localization'").bind(id),
      ]);
      return { route: r.results[0] ?? null, roads: roads.results, localization: loc.results[0] ?? null,
        manual: mr.results.length > 0, manual_localization: ml.results.length > 0 };
    },
    set(env, id, field, v, who) {
      const out = [env.DB.prepare('DELETE FROM route_road WHERE video_id = ?1').bind(id), env.DB.prepare('DELETE FROM route WHERE video_id = ?1').bind(id)];
      if (v.route) out.push(insertRow(env, 'route', { ...v.route, video_id: id }));
      for (const x of v.roads ?? []) out.push(insertRow(env, 'route_road', { ...x, video_id: id }));
      out.push(...setLocalization(env, id, v.localization, v.manual_localization, who));
      out.push(v.manual ? mark(env, id, 'route', who) : unmark(env, id, 'route'));
      return out;
    },
  },
  // Localization row + its manual flag (Prüfmodus result).
  localization: {
    async get(env, id) {
      const loc = await env.DB.prepare('SELECT * FROM localization WHERE video_id = ?1').bind(id).first();
      return { localization: loc ?? null, manual: await isManual(env, id, 'localization') };
    },
    set(env, id, field, v, who) { return setLocalization(env, id, v.localization, v.manual, who); },
  },
  // A whole sync track (route_sync + sync_track) with the localization and both manual flags: the uploaded video2gpx result.
  sync: {
    async get(env, id) {
      const [s, t, loc, ms, ml] = await env.DB.batch([
        env.DB.prepare('SELECT * FROM route_sync WHERE video_id = ?1').bind(id),
        env.DB.prepare('SELECT * FROM sync_track WHERE video_id = ?1').bind(id),
        env.DB.prepare('SELECT * FROM localization WHERE video_id = ?1').bind(id),
        env.DB.prepare("SELECT 1 FROM manual_field WHERE video_id = ?1 AND field = 'sync'").bind(id),
        env.DB.prepare("SELECT 1 FROM manual_field WHERE video_id = ?1 AND field = 'localization'").bind(id),
      ]);
      return { sync: s.results[0] ?? null, track: t.results[0] ?? null, localization: loc.results[0] ?? null,
        manual: ms.results.length > 0, manual_localization: ml.results.length > 0 };
    },
    set(env, id, field, v, who) {
      const out = [env.DB.prepare('DELETE FROM route_sync WHERE video_id = ?1').bind(id), env.DB.prepare('DELETE FROM sync_track WHERE video_id = ?1').bind(id)];
      if (v.sync) out.push(insertRow(env, 'route_sync', { ...v.sync, video_id: id }));
      if (v.track) out.push(insertRow(env, 'sync_track', { ...v.track, video_id: id }));
      out.push(v.manual ? mark(env, id, 'sync', who) : unmark(env, id, 'sync'));
      out.push(...setLocalization(env, id, v.localization, v.manual_localization, who));
      return out;
    },
  },
  // video_id = the video, field = collection id; value = position or null
  collection_item: {
    async get(env, id, field) {
      const r = await env.DB.prepare('SELECT position FROM collection_item WHERE collection_id = ?1 AND video_id = ?2').bind(+field, id).first();
      return r ? r.position : null;
    },
    set(env, id, field, v) {
      return [v == null ? env.DB.prepare('DELETE FROM collection_item WHERE collection_id = ?1 AND video_id = ?2').bind(+field, id)
        : env.DB.prepare('INSERT OR REPLACE INTO collection_item (collection_id, video_id, position) VALUES (?1, ?2, ?3)').bind(+field, id, v),
        env.DB.prepare('UPDATE collection SET updated_at = ?2 WHERE collection_id = ?1').bind(+field, now())];
    },
  },
  // field = collection id; value = [video ids in order]
  collection_order: {
    async get(env, id, field) {
      const { results } = await env.DB.prepare('SELECT video_id FROM collection_item WHERE collection_id = ?1 ORDER BY position, video_id').bind(+field).all();
      return results.map((r) => r.video_id);
    },
    set(env, id, field, v) {
      return v.map((vid, i) => env.DB.prepare('UPDATE collection_item SET position = ?3 WHERE collection_id = ?1 AND video_id = ?2').bind(+field, vid, i + 1));
    },
  },
  // field = collection id; value = {collection row, items} or null
  collection: {
    async get(env, id, field) {
      const c = await env.DB.prepare('SELECT * FROM collection WHERE collection_id = ?1').bind(+field).first();
      if (!c) return null;
      const { results } = await env.DB.prepare('SELECT video_id, position, note FROM collection_item WHERE collection_id = ?1 ORDER BY position').bind(+field).all();
      return { collection: { ...c }, items: results };
    },
    set(env, id, field, v) {
      const out = [env.DB.prepare('DELETE FROM collection_item WHERE collection_id = ?1').bind(+field), env.DB.prepare('DELETE FROM collection WHERE collection_id = ?1').bind(+field)];
      if (v) {
        out.push(insertRow(env, 'collection', { ...v.collection, collection_id: +field }));
        for (const it of v.items ?? []) out.push(insertRow(env, 'collection_item', { ...it, collection_id: +field }));
      }
      return out;
    },
  },
  // field = channel id; value = {requested_at, note} or null
  optout: {
    async get(env, id, field) { const r = await env.DB.prepare('SELECT requested_at, note FROM channel_optout WHERE channel_id = ?1').bind(field).first(); return r ? { ...r } : null; },
    set(env, id, field, v) {
      return [v ? env.DB.prepare('INSERT OR REPLACE INTO channel_optout (channel_id, requested_at, note) VALUES (?1, ?2, ?3)').bind(field, v.requested_at, v.note ?? null)
        : env.DB.prepare('DELETE FROM channel_optout WHERE channel_id = ?1').bind(field)];
    },
  },
};

function insertRow(env, table, row) {
  const cols = Object.keys(row);
  return env.DB.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `?${i + 1}`).join(', ')})`).bind(...cols.map((c) => row[c] ?? null));
}
function setLocalization(env, id, loc, manual, who) {
  const out = [env.DB.prepare('DELETE FROM localization WHERE video_id = ?1').bind(id)];
  if (loc) out.push(insertRow(env, 'localization', { ...loc, video_id: id }));
  out.push(manual ? mark(env, id, 'localization', who) : unmark(env, id, 'localization'));
  return out;
}

/**
 * Sets entity state and logs it. Returns {changed, log_id?}. `extra` statements run in the same batch.
 * @param {{undoOf?: number, extra?: D1PreparedStatement[]}} o
 */
export async function change(env, who, entity, videoId, field, next, { undoOf = null, extra = [], old: knownOld } = {}) {
  const h = H[entity];
  if (!h) bad(`unbekannter Bereich ${entity}`);
  const old = knownOld !== undefined ? knownOld : await h.get(env, videoId, field);
  if (same(old, next) && !undoOf) return { changed: false };
  const at = now();
  const stmts = [...h.set(env, videoId, field, next, who), ...extra,
    env.DB.prepare('INSERT INTO edit_log (video_id, entity, field, old, new, old_manual, who, at, undo_of) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)')
      .bind(videoId, entity, String(field), J(old), J(next), old && typeof old === 'object' && 'manual' in old ? (old.manual ? 1 : 0) : null, who, at, undoOf)];
  if (undoOf) stmts.push(env.DB.prepare('UPDATE edit_log SET undone_by = (SELECT max(id) FROM edit_log WHERE undo_of = ?1) WHERE id = ?1').bind(undoOf));
  const res = await env.DB.batch(stmts);
  return { changed: true, log_id: res.at(undoOf ? -2 : -1).meta?.last_row_id ?? null };
}

export async function undo(env, who, logId, origin) {
  const row = await env.DB.prepare('SELECT * FROM edit_log WHERE id = ?1').bind(logId).first();
  if (!row) throw new HttpError(404, 'Eintrag nicht gefunden');
  if (row.undone_by) throw new HttpError(409, 'Schon zurückgenommen');
  if (!H[row.entity]) throw new HttpError(400, 'Diese Änderung lässt sich nicht zurücknehmen');
  const old = parse(row.old), cur = await H[row.entity].get(env, row.video_id, row.field);
  if (!same(cur, parse(row.new))) throw new HttpError(409, 'Der Wert wurde seitdem erneut geändert; zuerst die spätere Änderung zurücknehmen');
  const r = await change(env, who, row.entity, row.video_id, row.field, old, { undoOf: row.id, old: cur });
  if (['anchor', 'route'].includes(row.entity)) await recomputeSync(env, row.video_id, who, origin);
  return r;
}

// --- route line, sync tracks ---

/** The route line [[lon, lat], …]: the full OSM line of the static GPX for pipeline routes, the stored line for manual ones. */
export async function routeLine(env, id, route, origin) {
  if (!route) return null;
  const poly = parse(route.polyline)?.map(([la, lo]) => [lo, la]) ?? null;
  if (route.gpx_path?.startsWith('gpx/') && env.ASSETS && origin) {
    try {
      const res = await env.ASSETS.fetch(new Request(`${origin}/${route.gpx_path}`));
      if (res.ok) {
        const pts = [...(await res.text()).matchAll(/<trkpt lat="([-\d.]+)" lon="([-\d.]+)"/g)].map((m) => [+m[2], +m[1]]);
        if (pts.length > 1) return pts;
      }
    } catch { /* fall back to the stored line */ }
  }
  return poly;
}

/** The time-synced track of a video ({t, c}) from D1 (anchors, uploaded video2gpx results) or the static asset (pipeline), or null. */
export async function loadTrack(env, id, sync, origin) {
  if (!sync) return null;
  if (sync.method === 'anchors' || sync.path?.startsWith('api/sync/')) {
    const r = await env.DB.prepare('SELECT json FROM sync_track WHERE video_id = ?1').bind(id).first();
    return r ? JSON.parse(r.json) : null;
  }
  if (!env.ASSETS || !origin || !sync.path) return null;
  const res = await env.ASSETS.fetch(new Request(`${origin}/${sync.path}`));
  return res.ok ? res.json() : null;
}

const hashText = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s)))].slice(0, 8).map((x) => x.toString(16).padStart(2, '0')).join('');
const routeLevelOf = (loc) => parse(loc?.gates)?.route ?? (loc && loc.loc_level >= 4 ? loc.loc_level : 4);

/**
 * Recomputes the anchor track of a video after anchors or the route changed (concept 3.5): piecewise along
 * the route between anchors, speed model outside; stores it in sync_track, points route_sync at
 * /api/sync/<id>.json and sets the Lokalisierungsstufe by anchorLevel(). Pipeline tracks (video2gpx) are not
 * replaced: their anchors are kept for the next pipeline run.
 */
export async function recomputeSync(env, id, who, origin) {
  const [vr, rr, lr, sr, ar] = await env.DB.batch([
    env.DB.prepare('SELECT duration_s, position_exact FROM video WHERE video_id = ?1').bind(id),
    env.DB.prepare('SELECT * FROM route WHERE video_id = ?1').bind(id),
    env.DB.prepare('SELECT * FROM localization WHERE video_id = ?1').bind(id),
    env.DB.prepare('SELECT * FROM route_sync WHERE video_id = ?1').bind(id),
    env.DB.prepare('SELECT video_t_s AS t, lon, lat, source FROM sync_anchor WHERE video_id = ?1 ORDER BY video_t_s').bind(id),
  ]);
  const v = vr.results[0], route = rr.results[0], loc = lr.results[0], sync = sr.results[0], anchors = ar.results;
  if (!v) return { status: 'no_video' };
  if (sync && sync.method !== 'anchors') return { status: 'pipeline_track', anchors: anchors.length };
  const routeLevel = routeLevelOf(loc);
  const dropTrack = [env.DB.prepare('DELETE FROM sync_track WHERE video_id = ?1').bind(id),
    env.DB.prepare("DELETE FROM route_sync WHERE video_id = ?1 AND method = 'anchors'").bind(id), unmark(env, id, 'sync')];
  const line = await routeLine(env, id, route, origin);
  const built = line && anchors.length ? buildTrack({ line, anchors, duration: v.duration_s, profile: parse(route?.profile) }) : null;
  if (!built) {
    // No anchors (or no route): the level falls back to what the route alone gives.
    const stmts = [...dropTrack];
    if (loc && loc.loc_level < routeLevel && loc.method === 'anchors_manual') {
      stmts.push(env.DB.prepare(`UPDATE localization SET loc_level = ?2, loc_key = ?3, method = ?4, anchor_count = 0, anchors_manual = 0,
        verified_by = NULL, verified_at = NULL, verified_hash = NULL, updated_at = ?5 WHERE video_id = ?1`).bind(id, routeLevel, KEYS[routeLevel], route?.method ?? null, now()),
      locLog(env, id, loc.loc_level, routeLevel, 'anchors_removed'));
    }
    await env.DB.batch(stmts);
    return { status: line ? 'no_anchors' : 'no_route', level: Math.max(loc?.loc_level ?? 7, routeLevel) };
  }
  const json = JSON.stringify(built.track), hash = await hashText(json);
  const lv = anchorLevel({ routeLevel, routeKm: built.routeKm, anchorKms: built.anchors.map((a) => a.km) });
  const from = loc?.loc_level ?? null, at = now();
  const manualCount = anchors.filter((a) => a.source === 'manual' || a.source === 'review').length;
  const stmts = [
    env.DB.prepare('INSERT OR REPLACE INTO sync_track (video_id, json, hash, built_at) VALUES (?1, ?2, ?3, ?4)').bind(id, json, hash, at),
    env.DB.prepare(`INSERT OR REPLACE INTO route_sync (video_id, method, t_start_s, t_end_s, path, hash, built_at) VALUES (?1, 'anchors', ?2, ?3, ?4, ?5, ?6)`)
      .bind(id, built.track.t[0], built.track.t.at(-1), `api/sync/${id}.json`, hash, at),
    mark(env, id, 'sync', who),
  ];
  // A changed track loses a verification (concept 2.5, "Herabstufen").
  const keepVerified = loc?.loc_level === 1 && loc.verified_hash === hash;
  if (!keepVerified) {
    stmts.push(insertRow(env, 'localization', {
      video_id: id, loc_level: lv.level, loc_key: lv.key, method: 'anchors_manual', err_along_med_m: null, err_along_max_m: null,
      anchor_count: built.anchors.length, anchors_manual: manualCount, verified_by: null, verified_at: null, verified_hash: null,
      check_points: loc?.check_points ?? null, gates: J({ route: routeLevel, anchors: lv.reason, need: lv.need, start: lv.hasStart, end: lv.hasEnd }),
      rules_version: LOC_RULES.version, updated_at: at }), mark(env, id, 'localization', who));
    if (from !== lv.level) stmts.push(locLog(env, id, from, lv.level, from === 1 ? 'track_changed' : 'anchors_added'));
  }
  await env.DB.batch(stmts);
  return { status: 'built', level: keepVerified ? 1 : lv.level, rule: lv, factor: built.factor, dropped: built.dropped.map((a) => a.t), points: built.track.t.length, hash };
}

// --- video2gpx (VIDEO2GPX-INTEGRATION.md steps A/B, contract section 8) ---

/** The job of a video, or null when it does not exist (`where`: extra condition on video v, e.g. visibility for the public endpoint). */
export async function loadJob(env, id, origin, { where = '' } = {}) {
  const v = await env.DB.prepare(`SELECT v.*, c.name AS channel_name FROM video v LEFT JOIN channel c ON c.channel_id = v.channel_id
    WHERE v.video_id = ?1 ${where ? `AND ${where}` : ''}`).bind(id).first();
  if (!v) return null;
  const [tech, route, loc] = await env.DB.batch([
    env.DB.prepare('SELECT fps FROM video_tech WHERE video_id = ?1').bind(id),
    env.DB.prepare('SELECT * FROM route WHERE video_id = ?1').bind(id),
    env.DB.prepare('SELECT * FROM localization WHERE video_id = ?1').bind(id),
  ]);
  const r = route.results[0] ?? null;
  const line = await routeLine(env, id, r, origin);
  return { job: buildJob({ v, tech: tech.results[0], route: r, loc: loc.results[0], line, base: origin }), line, video: v };
}

/**
 * Stores an uploaded video2gpx result (<id>.scenic.json): validated against the job, then sync_track + route_sync (method video2gpx,
 * /api/sync/<id>.json), manual (the import never overwrites it), Lokalisierungsstufe 2 with the route agreement. One logged change (undo).
 */
async function uploadResult(env, who, id, request, origin) {
  const len = +request.headers.get('content-length') || 0;
  if (len > MAX_RESULT_BYTES) throw new HttpError(413, 'Höchstens 1,5 MB');
  const text = await request.text();
  if (text.length > MAX_RESULT_BYTES) throw new HttpError(413, 'Höchstens 1,5 MB');
  let p;
  try { p = JSON.parse(text); } catch { bad('Die Datei ist kein JSON'); }
  const j = await loadJob(env, id, origin);
  if (!j) throw new HttpError(404, 'Video nicht gefunden');
  let res;
  try { res = validateResult(p, j.job, { durationS: j.video.duration_s }); } catch (e) { if (e.status) throw new HttpError(e.status, e.message); throw e; }
  const cur = await H.sync.get(env, id), loc0 = cur.localization;
  const json = JSON.stringify(res.track), hash = await hashText(json), at = now();
  const agree = routeAgreement(j.line, res.track.c);
  const level = uploadLevel(loc0, hash), routeLevel = j.job.route_level;
  const meta = resultMeta(p, who);
  const next = {
    manual: true, manual_localization: true,
    sync: { video_id: id, method: 'video2gpx', t_start_s: Math.round(res.t_start), t_end_s: Math.round(res.t_end), path: `api/sync/${id}.json`, hash, built_at: at },
    track: { video_id: id, json, hash, built_at: at },
    localization: { video_id: id, loc_level: level, loc_key: KEYS[level], method: 'video2gpx',
      err_along_med_m: level === 1 ? loc0.err_along_med_m : null, err_along_max_m: level === 1 ? loc0.err_along_max_m : null, err_cross_med_m: agree?.median_m ?? null,
      anchor_count: null, anchors_manual: null,
      verified_by: level === 1 ? loc0.verified_by : null, verified_at: level === 1 ? loc0.verified_at : null, verified_hash: level === 1 ? hash : null,
      check_points: level === 1 ? loc0.check_points : null,
      gates: J({ route: routeLevel, source: 'video2gpx', route_agreement: agree, video2gpx: meta }), rules_version: LOC_RULES.version, updated_at: at },
  };
  const result = { level, hash, points: res.track.t.length, route_agreement: agree, route_offer: !agree || agree.median_m > ROUTE_OFFER_M, route_offer_m: ROUTE_OFFER_M };
  // The same file again (same track, same checklist, same person): nothing to store.
  if (cur.sync?.method === 'video2gpx' && cur.sync.hash === hash && cur.localization?.gates === next.localization.gates) return { changed: false, ...result, level: cur.localization.loc_level };
  const from = loc0?.loc_level ?? null;
  const extra = from !== level ? [locLog(env, id, from, level, from === 1 ? 'track_changed' : 'video2gpx_uploaded')] : [];
  const r = await change(env, who, 'sync', id, 'video2gpx', next, { old: cur, extra });
  return { ...r, ...result };
}

// --- OSRM (public demo server: at most one request per second, car profile) ---
let lastOsrm = 0;
export async function osrmRoute(points) {
  if (!Array.isArray(points) || points.length < 2 || points.length > 25) bad('2 bis 25 Punkte');
  const pts = points.map((p) => { const lon = +p[0], lat = +p[1]; if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) bad('Ungültiger Punkt'); return `${lon.toFixed(6)},${lat.toFixed(6)}`; });
  const wait = lastOsrm + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastOsrm = Date.now();
  const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${pts.join(';')}?overview=full&geometries=geojson&steps=false`,
    { headers: { 'user-agent': 'ridrs-scenic-admin/1 (manual route editing)' } });
  if (res.status === 429) throw new HttpError(429, 'OSRM: zu viele Anfragen, kurz warten');
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.code !== 'Ok' || !data.routes?.length) throw new HttpError(502, `OSRM: ${data?.message || data?.code || res.status}`);
  const r = data.routes[0];
  return { line: r.geometry.coordinates.map(([lo, la]) => [Math.round(lo * 1e6) / 1e6, Math.round(la * 1e6) / 1e6]), distance_km: Math.round(r.distance / 100) / 10 };
}

// --- request handling ---

const readJson = async (req) => { try { return await req.json(); } catch { bad('JSON erwartet'); } };

async function videoDetail(env, id, origin) {
  const v = await env.DB.prepare(`SELECT v.*, c.name AS channel_name, (o.channel_id IS NOT NULL) AS channel_optout FROM video v
    LEFT JOIN channel c ON c.channel_id = v.channel_id LEFT JOIN channel_optout o ON o.channel_id = v.channel_id WHERE v.video_id = ?1`).bind(id).first();
  if (!v) throw new HttpError(404, 'Video nicht gefunden');
  const [tech, route, loc, sync, anchors, manual, images, cols, log] = await env.DB.batch([
    env.DB.prepare('SELECT max_height, max_width, fps, hdr FROM video_tech WHERE video_id = ?1').bind(id),
    env.DB.prepare('SELECT * FROM route WHERE video_id = ?1').bind(id),
    env.DB.prepare('SELECT * FROM localization WHERE video_id = ?1').bind(id),
    env.DB.prepare('SELECT * FROM route_sync WHERE video_id = ?1').bind(id),
    env.DB.prepare('SELECT video_t_s AS t, lon, lat, source FROM sync_anchor WHERE video_id = ?1 ORDER BY video_t_s').bind(id),
    env.DB.prepare('SELECT field, who, at FROM manual_field WHERE video_id = ?1').bind(id),
    env.DB.prepare('SELECT image_id, kind, mime, bytes, width, height, rights, credit, uploaded_by, uploaded_at, is_primary FROM video_image WHERE video_id = ?1 ORDER BY is_primary DESC, uploaded_at DESC').bind(id),
    env.DB.prepare('SELECT c.collection_id, c.title, i.position FROM collection_item i JOIN collection c USING (collection_id) WHERE i.video_id = ?1').bind(id),
    env.DB.prepare('SELECT id, entity, field, old, new, who, at, undo_of, undone_by FROM edit_log WHERE video_id = ?1 ORDER BY id DESC LIMIT 60').bind(id),
  ]);
  const r = route.results[0], l = loc.results[0];
  const line = await routeLine(env, id, r, origin);
  let anchorsOut = anchors.results;
  if (line && anchorsOut.length) {
    const cum = kmAlong(line);
    anchorsOut = anchorsOut.map((a) => ({ ...a, km: Math.round(project(line, cum, [a.lon, a.lat]).km * 1000) / 1000 }));
  }
  const routeKm = line ? kmAlong(line).at(-1) : null;
  return {
    id, title: v.title, channel: { id: v.channel_id, name: v.channel_name, optout: !!v.channel_optout }, duration_s: v.duration_s, status: v.status,
    embeddable: !!v.embeddable, published: v.published_at, views: v.view_count,
    stars: v.stars, editors_pick: !!v.editors_pick, editor_note: v.editor_note, hidden: !!v.hidden, site_published: !!v.site_published,
    place: v.place, region: v.region, country: v.country, country_name: v.country_name, lat: v.lat, lon: v.lon, position_exact: !!v.position_exact,
    tech: tech.results[0] ?? null,
    route: r ? { distance_km: r.distance_km, method: r.method, via: parse(r.manual_via), line, km: routeKm, profile: parse(r.profile), gpx: r.gpx_path } : null,
    localization: l ? { ...l, gates: parse(l.gates), check_points: parse(l.check_points) } : null,
    sync: sync.results[0] ?? null, anchors: anchorsOut,
    rules: { version: LOC_RULES.version, end_tolerance_km: routeKm ? LOC_RULES.endToleranceKm(routeKm) : null,
      need: routeKm ? Math.max(2, Math.ceil(routeKm / LOC_RULES.kmPerAnchor)) : null, review_max_dev_m: LOC_RULES.reviewMaxDevM, review_min_points: LOC_RULES.reviewMinPoints },
    manual: manual.results, images: images.results, collections: cols.results,
    log: log.results.map((x) => ({ ...x, old: parse(x.old), new: parse(x.new) })),
  };
}

async function listVideos(env, url) {
  const q = (url.searchParams.get('q') || '').trim(), only = url.searchParams.get('only') || '', loc = +url.searchParams.get('loc') || 0;
  const offset = Math.max(0, +url.searchParams.get('offset') || 0);
  const where = [], binds = [];
  if (q) {
    binds.push(`%${q.replace(/[%_]/g, '')}%`, q);
    where.push(`(v.video_id = ?${binds.length} OR v.title LIKE ?${binds.length - 1} OR v.place LIKE ?${binds.length - 1} OR c.name LIKE ?${binds.length - 1})`);
  }
  if (loc) { binds.push(loc); where.push(`l.loc_level <= ?${binds.length}`); }
  const ONLY = { site_published: 'v.site_published = 1', unpublished: 'v.site_published = 0', hidden: 'v.hidden = 1', pick: 'v.editors_pick = 1', stars: 'v.stars IS NOT NULL', note: 'v.editor_note IS NOT NULL',
    manual: 'EXISTS (SELECT 1 FROM manual_field m WHERE m.video_id = v.video_id)', anchors: 'EXISTS (SELECT 1 FROM sync_anchor a WHERE a.video_id = v.video_id)',
    review: 'l.loc_level = 2', route: 'r.video_id IS NOT NULL', optout: 'o.channel_id IS NOT NULL' };
  if (ONLY[only]) where.push(ONLY[only]);
  // Map view (?map=1): every matching video with a position, all at once, as compact positional rows.
  if (url.searchParams.get('map') === '1') {
    where.push('v.lat IS NOT NULL');
    const { results } = await env.DB.prepare(`SELECT v.video_id, v.title, v.lon, v.lat, l.loc_level, v.site_published, v.hidden, (o.channel_id IS NOT NULL) AS optout
      FROM video v LEFT JOIN channel c ON c.channel_id = v.channel_id LEFT JOIN localization l ON l.video_id = v.video_id LEFT JOIN route r ON r.video_id = v.video_id
      LEFT JOIN channel_optout o ON o.channel_id = v.channel_id WHERE ${where.join(' AND ')} ORDER BY v.view_count DESC`).bind(...binds).all();
    return { fields: ['id', 'title', 'lon', 'lat', 'loc', 'pub', 'hidden', 'optout'],
      rows: results.map((r) => [r.video_id, r.title, r.lon, r.lat, r.loc_level ?? 7, r.site_published, r.hidden, r.optout]) };
  }
  const { results } = await env.DB.prepare(`SELECT v.video_id, v.title, c.name AS channel, v.place, v.country, v.duration_s, v.view_count, v.stars, v.editors_pick, v.hidden, v.site_published,
      l.loc_level, r.distance_km, (s.video_id IS NOT NULL) AS synced, (o.channel_id IS NOT NULL) AS optout,
      (SELECT count(*) FROM sync_anchor a WHERE a.video_id = v.video_id) AS anchors
    FROM video v LEFT JOIN channel c ON c.channel_id = v.channel_id LEFT JOIN localization l ON l.video_id = v.video_id
    LEFT JOIN route r ON r.video_id = v.video_id LEFT JOIN route_sync s ON s.video_id = v.video_id LEFT JOIN channel_optout o ON o.channel_id = v.channel_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY v.view_count DESC LIMIT 101 OFFSET ${offset}`).bind(...binds).all();
  return { rows: results.slice(0, 100), more: results.length > 100, offset };
}

async function patchVideo(env, who, id, body) {
  const out = {};
  for (const [field, raw] of Object.entries(body)) {
    const spec = VIDEO_FIELDS[field];
    if (!spec) bad(`Feld ${field} ist nicht editierbar`);
    const value = spec.parse(raw);
    out[field] = await change(env, who, 'video', id, field, spec.manual ? { value, manual: true } : { value });
  }
  return out;
}

async function addAnchor(env, who, id, body, origin) {
  const t = Math.round(+body.t * 10) / 10;
  const v = await env.DB.prepare('SELECT duration_s FROM video WHERE video_id = ?1').bind(id).first();
  if (!v) throw new HttpError(404, 'Video nicht gefunden');
  if (!(t >= 0) || (v.duration_s && t > v.duration_s)) bad('Videozeit außerhalb des Videos');
  const route = await env.DB.prepare('SELECT * FROM route WHERE video_id = ?1').bind(id).first();
  const line = await routeLine(env, id, route, origin);
  if (!line) bad('Ohne Route keine Anker: zuerst eine Route setzen');
  const p = project(line, kmAlong(line), [+body.lon, +body.lat]);
  if (p.dist_m > 2000) bad(`Der Punkt liegt ${Math.round(p.dist_m)} m neben der Route`);
  const value = { lon: Math.round(p.point[0] * 1e6) / 1e6, lat: Math.round(p.point[1] * 1e6) / 1e6, source: body.source === 'review' ? 'review' : 'manual' };
  const r = await change(env, who, 'anchor', id, String(t), value);
  return { ...r, anchor: { t, ...value, km: p.km }, sync: await recomputeSync(env, id, who, origin) };
}

async function editRoute(env, who, id, body, origin) {
  const cur = await H.route.get(env, id);
  const v = await env.DB.prepare('SELECT position_exact FROM video WHERE video_id = ?1').bind(id).first();
  if (!v) throw new HttpError(404, 'Video nicht gefunden');
  const at = now(), loc0 = cur.localization;
  const locRow = (level, method, gates) => ({ ...(loc0 ?? {}), video_id: id, loc_level: level, loc_key: KEYS[level], method,
    anchor_count: null, anchors_manual: null, verified_by: null, verified_at: null, verified_hash: null, err_along_med_m: null, err_along_max_m: null,
    gates: J(gates), rules_version: LOC_RULES.version, updated_at: at });
  let next, level;
  if (body.action === 'discard') {
    level = v.position_exact ? 6 : 7;
    next = { route: null, roads: [], manual: true, localization: locRow(level, v.position_exact ? 'pin' : 'gazetteer', { route: level, manual: 'discarded' }), manual_localization: true };
  } else if (body.action === 'reverse') {
    if (!cur.route) bad('Keine Route');
    const r = cur.route, prof = parse(r.profile), km = prof?.at(-1)?.[0];
    next = { ...cur, manual: true, route: { ...r, polyline: J(parse(r.polyline)?.reverse()), manual_via: J(parse(r.manual_via)?.reverse() ?? null),
      profile: prof ? J(prof.map(([k, e]) => [Math.round((km - k) * 1000) / 1000, e]).reverse()) : null,
      ascent_m: r.descent_m, descent_m: r.ascent_m, gpx_path: `api/videos/${id}/route.gpx`, built_at: at,
      method: r.method?.endsWith('_reversed') ? r.method.replace(/_reversed$/, '') : `${r.method}_reversed` } };
  } else if (body.action === 'set') {
    const line = body.line;
    if (!Array.isArray(line) || line.length < 2 || line.length > 50000) bad('Linie fehlt');
    const via = Array.isArray(body.via) ? body.via.map(([lo, la]) => [+lo, +la]) : null;
    const km = Math.round(kmAlong(line).at(-1) * 10) / 10;
    level = 4;
    next = { roads: [], manual: true, manual_localization: true,
      route: { video_id: id, distance_km: km, method: 'manual_osrm', polyline: J(line.map(([lo, la]) => [+la, +lo])), gpx_path: `api/videos/${id}/route.gpx`,
        creator_links: cur.route?.creator_links ?? null, check_status: 'fixed', check_note: 'Route von Hand gesetzt (Admin, OSRM)', built_at: at, manual_via: J(via) },
      localization: locRow(4, 'manual_osrm', { route: 4, manual: 'osrm_via' }) };
  } else if (body.action === 'from_track') {
    // "Route aus video2gpx übernehmen" (VIDEO2GPX-INTEGRATION.md 5): the uploaded driving line becomes the route; the level stays.
    const sync = await env.DB.prepare('SELECT * FROM route_sync WHERE video_id = ?1').bind(id).first();
    if (sync?.method !== 'video2gpx' || !sync.path?.startsWith('api/sync/')) bad('Kein hochgeladener video2gpx-Track');
    const track = await loadTrack(env, id, sync, origin);
    if (!track?.c?.length) bad('Track nicht lesbar');
    const line = [track.c[0]];
    for (const p of track.c) { const q = line.at(-1); if (Math.hypot((p[0] - q[0]) * Math.cos(p[1] * Math.PI / 180), p[1] - q[1]) * 111320 >= 10) line.push(p); }
    if (line.at(-1) !== track.c.at(-1)) line.push(track.c.at(-1));
    if (line.length < 2) bad('Track zu kurz für eine Route');
    const km = Math.round(kmAlong(line).at(-1) * 10) / 10;
    next = { roads: [], manual: true, manual_localization: cur.manual_localization,
      route: { video_id: id, distance_km: km, method: 'video2gpx_track', polyline: J(line.map(([lo, la]) => [la, lo])), gpx_path: `api/videos/${id}/route.gpx`,
        creator_links: cur.route?.creator_links ?? null, check_status: 'fixed', check_note: 'Route aus dem video2gpx-Track übernommen (Admin)', built_at: at, manual_via: null },
      localization: loc0 ? { ...loc0, gates: J({ ...(parse(loc0.gates) ?? {}), route: 4, route_from_track: true }), updated_at: at } : null };
  } else bad('action: set | reverse | discard | from_track');
  const extra = level && loc0?.loc_level !== level ? [locLog(env, id, loc0?.loc_level, level, 'route_edited')] : [];
  const r = await change(env, who, 'route', id, 'route', next, { old: cur, extra });
  return { ...r, sync: await recomputeSync(env, id, who, origin) };
}

async function review(env, who, id, body, origin) {
  const sync = await env.DB.prepare('SELECT * FROM route_sync WHERE video_id = ?1').bind(id).first();
  if (!sync) bad('Kein synchroner Track');
  if (body.hash && sync.hash && body.hash !== sync.hash) throw new HttpError(409, 'Der Track hat sich während der Prüfung geändert');
  const track = await loadTrack(env, id, sync, origin);
  if (!track) bad('Track nicht lesbar');
  const route = await env.DB.prepare('SELECT * FROM route WHERE video_id = ?1').bind(id).first();
  const line = (await routeLine(env, id, route, origin)) ?? track.c;
  if (!Array.isArray(body.points)) bad('points fehlt');
  const res = evaluateReview({ line, track, points: body.points.map((p) => ({ t: +p.t, wrong_road: !!p.wrong_road, lon: p.lon ?? null, lat: p.lat ?? null })) });
  const cur = await H.localization.get(env, id), loc0 = cur.localization;
  const at = now(), from = loc0?.loc_level ?? null;
  if (from == null || from > 3) bad('Prüfmodus nur ab Lokalisierungsstufe 3 mit synchronem Track');
  const to = res.passed ? 1 : from === 1 ? 2 : from;
  const next = { manual: true, localization: { ...(loc0 ?? {}), video_id: id, loc_level: to, loc_key: KEYS[to],
    verified_by: res.passed ? who : null, verified_at: res.passed ? at : null, verified_hash: res.passed ? sync.hash : null,
    err_along_med_m: res.err_med_m, err_along_max_m: res.err_max_m, check_points: J(res.points.map(({ t, ok, dev_m, wrong_road }) => ({ t, ok, dev_m, wrong_road }))),
    rules_version: LOC_RULES.version, updated_at: at } };
  const r = await change(env, who, 'localization', id, 'review', next, { old: cur, extra: [locLog(env, id, from, to, res.passed ? 'review_passed' : 'review_failed')] });
  // Failed: the corrections become manual anchors (concept 2.5); an anchor track is recomputed with them.
  const added = [];
  if (!res.passed) {
    for (const p of res.points.filter((x) => x.lon != null && !x.wrong_road && x.dev_m > 0)) {
      try { added.push((await addAnchor(env, who, id, { t: p.t, lon: p.lon, lat: p.lat, source: 'review' }, origin)).anchor); } catch (err) { console.warn('review anchor', err.message); }
    }
  }
  return { ...res, level: to, log_id: r.log_id, anchors_added: added };
}

async function uploadImage(env, who, id, request) {
  if (!env.IMAGES) throw new HttpError(501, 'R2-Binding IMAGES fehlt');
  if (!(await env.DB.prepare('SELECT 1 FROM video WHERE video_id = ?1').bind(id).first())) throw new HttpError(404, 'Video nicht gefunden');
  const len = +request.headers.get('content-length') || 0;
  if (len > MAX_IMAGE_BYTES + 64 * 1024) throw new HttpError(413, 'Höchstens 10 MB');
  const form = await request.formData().catch(() => bad('Formular erwartet'));
  const file = form.get('file');
  if (!file || typeof file === 'string') bad('Datei fehlt');
  if (file.size > MAX_IMAGE_BYTES) throw new HttpError(413, 'Höchstens 10 MB');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const info = sniffImage(bytes);
  if (!info) throw new HttpError(415, 'Nur JPG, PNG oder WebP');
  const rights = String(form.get('rights') || '');
  if (!RIGHTS.includes(rights)) bad('Rechte angeben: own, cc0, cc_by oder licensed');
  const credit = str(300)(String(form.get('credit') || ''));
  if ((rights === 'cc_by' || rights === 'licensed') && !credit) bad('Namensnennung angeben');
  const image_id = await contentId(bytes), key = `images/${id}/${image_id}.${info.ext}`, at = now();
  await env.IMAGES.put(key, bytes, { httpMetadata: { contentType: info.mime } });
  const hasPrimary = await env.DB.prepare('SELECT 1 FROM video_image WHERE video_id = ?1 AND is_primary = 1').bind(id).first();
  const primary = form.get('primary') === '1' || !hasPrimary;
  const row = { image_id, video_id: id, kind: 'upload', r2_key: key, mime: info.mime, bytes: bytes.length, width: info.width, height: info.height,
    rights, credit, uploaded_by: who, uploaded_at: at, is_primary: primary ? 1 : 0 };
  await env.DB.batch([
    ...(primary ? [env.DB.prepare('UPDATE video_image SET is_primary = 0 WHERE video_id = ?1').bind(id)] : []),
    insertRow(env, 'video_image', row),
    logOnly(env, id, 'image', image_id, null, row, who),
  ]);
  return row;
}
const logOnly = (env, id, entity, field, old, next, who) => env.DB.prepare('INSERT INTO edit_log (video_id, entity, field, old, new, who, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
  .bind(id, entity, field, J(old), J(next), who, now());

async function patchImage(env, who, iid, body) {
  const img = await env.DB.prepare('SELECT * FROM video_image WHERE image_id = ?1').bind(iid).first();
  if (!img) throw new HttpError(404, 'Bild nicht gefunden');
  const next = { ...img };
  if ('rights' in body) { if (!RIGHTS.includes(body.rights)) bad('Rechte: own, cc0, cc_by oder licensed'); next.rights = body.rights; }
  if ('credit' in body) next.credit = str(300)(body.credit);
  if (body.is_primary) next.is_primary = 1;
  await env.DB.batch([
    ...(body.is_primary ? [env.DB.prepare('UPDATE video_image SET is_primary = 0 WHERE video_id = ?1').bind(img.video_id)] : []),
    insertRow(env, 'video_image', next), logOnly(env, img.video_id, 'image', iid, img, next, who)]);
  return next;
}
async function deleteImage(env, who, iid) {
  const img = await env.DB.prepare('SELECT * FROM video_image WHERE image_id = ?1').bind(iid).first();
  if (!img) throw new HttpError(404, 'Bild nicht gefunden');
  await env.IMAGES?.delete(img.r2_key);
  await env.DB.batch([env.DB.prepare('DELETE FROM video_image WHERE image_id = ?1').bind(iid),
    // The newest remaining image becomes the main image.
    env.DB.prepare(`UPDATE video_image SET is_primary = 1 WHERE image_id = (SELECT image_id FROM video_image WHERE video_id = ?1 ORDER BY uploaded_at DESC LIMIT 1)
      AND NOT EXISTS (SELECT 1 FROM video_image WHERE video_id = ?1 AND is_primary = 1)`).bind(img.video_id),
    logOnly(env, img.video_id, 'image', iid, img, null, who)]);
  return { deleted: iid };
}

const slugify = (s) => String(s || '').toLowerCase().replace(/ß/g, 'ss').normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
async function collections(env) {
  const [c, i] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM collection ORDER BY position, collection_id'),
    env.DB.prepare(`SELECT i.collection_id, i.video_id, i.position, v.title, v.place, l.loc_level FROM collection_item i LEFT JOIN video v USING (video_id)
      LEFT JOIN localization l USING (video_id) ORDER BY i.collection_id, i.position`),
  ]);
  return c.results.map((x) => ({ ...x, items: i.results.filter((y) => y.collection_id === x.collection_id) }));
}
async function collectionWrite(env, who, method, parts, body) {
  // parts: [] | [cid] | [cid, 'items'] | [cid, 'items', vid] | ['order']
  if (parts[0] === 'order' && method === 'PUT') {
    const order = body.order;
    if (!Array.isArray(order)) bad('order fehlt');
    await env.DB.batch(order.map((cid, i) => env.DB.prepare('UPDATE collection SET position = ?2 WHERE collection_id = ?1').bind(+cid, i + 1)));
    return { ok: true };
  }
  if (!parts.length && method === 'POST') {
    const title = str(200)(body.title);
    if (!title) bad('Titel fehlt');
    const slug = slugify(body.slug || title) || `liste-${Date.now()}`;
    if (await env.DB.prepare('SELECT 1 FROM collection WHERE slug = ?1').bind(slug).first()) throw new HttpError(409, `Kurzname ${slug} gibt es schon`);
    const max = (await env.DB.prepare('SELECT max(collection_id) AS m, max(position) AS p FROM collection').first()) ?? {};
    const cid = (max.m ?? 0) + 1, at = now();
    const row = { collection_id: cid, slug, title, description: str(2000)(body.description), position: (max.p ?? 0) + 1, created_at: at, updated_at: at };
    await change(env, who, 'collection', null, String(cid), { collection: row, items: [] }, { old: null });
    return row;
  }
  const cid = +parts[0];
  const cur = await H.collection.get(env, null, cid);
  if (!cur) throw new HttpError(404, 'Sammlung nicht gefunden');
  if (parts.length === 1 && method === 'PATCH') {
    const c = { ...cur.collection };
    if ('title' in body) c.title = str(200)(body.title) || bad('Titel fehlt');
    if ('description' in body) c.description = str(2000)(body.description);
    if ('slug' in body) {
      c.slug = slugify(body.slug) || bad('Kurzname fehlt');
      if (await env.DB.prepare('SELECT 1 FROM collection WHERE slug = ?1 AND collection_id != ?2').bind(c.slug, cid).first()) throw new HttpError(409, 'Kurzname vergeben');
    }
    return change(env, who, 'collection', null, String(cid), { ...cur, collection: { ...c, updated_at: now() } }, { old: cur });
  }
  if (parts.length === 1 && method === 'DELETE') return change(env, who, 'collection', null, String(cid), null, { old: cur });
  if (parts[1] === 'items') {
    if (parts.length === 2 && method === 'POST') {
      const vid = body.video_id;
      if (!ID.test(vid || '') || !(await env.DB.prepare('SELECT 1 FROM video WHERE video_id = ?1').bind(vid).first())) bad('Unbekannte Video-ID');
      if (cur.items.some((x) => x.video_id === vid)) return { changed: false };
      return change(env, who, 'collection_item', vid, String(cid), Math.max(0, ...cur.items.map((x) => x.position)) + 1);
    }
    if (parts.length === 2 && method === 'PUT') {
      const order = body.order;
      if (!Array.isArray(order) || order.length !== cur.items.length || !cur.items.every((x) => order.includes(x.video_id))) bad('order muss alle Einträge enthalten');
      return change(env, who, 'collection_order', null, String(cid), order);
    }
    if (parts.length === 3 && method === 'DELETE') return change(env, who, 'collection_item', parts[2], String(cid), null);
  }
  throw new HttpError(405, 'Methode nicht erlaubt');
}

async function optouts(env) {
  const { results } = await env.DB.prepare(`SELECT o.channel_id, o.requested_at, o.note, c.name, (SELECT count(*) FROM video v WHERE v.channel_id = o.channel_id) AS videos
    FROM channel_optout o LEFT JOIN channel c USING (channel_id) ORDER BY o.requested_at DESC`).all();
  return results;
}

/** All manual data as ndjson, for scripts/pull_manual.mjs -> data/manual.json of the pipeline (concept 4.3). */
async function exportManual(env) {
  const q = (sql) => env.DB.prepare(sql).all().then((r) => r.results);
  const [videos, manual, routes, locs, anchors, syncs, cols, items, opt, imgs, log, loclog] = await Promise.all([
    q(`SELECT video_id, stars, editors_pick, editor_note, hidden, site_published, place, region, lat, lon, position_exact, country, country_name FROM video
       WHERE stars IS NOT NULL OR editors_pick = 1 OR editor_note IS NOT NULL OR hidden = 1 OR site_published = 1 OR video_id IN (SELECT video_id FROM manual_field)`),
    q('SELECT video_id, field, who, at FROM manual_field'),
    q(`SELECT m.video_id, r.distance_km, r.method, r.polyline, r.manual_via, r.profile, r.ascent_m, r.descent_m, (r.video_id IS NULL) AS discarded
       FROM manual_field m LEFT JOIN route r USING (video_id) WHERE m.field = 'route'`),
    q(`SELECT l.* FROM localization l JOIN manual_field m ON m.video_id = l.video_id AND m.field = 'localization'`),
    q('SELECT video_id, video_t_s AS t, lon, lat, source FROM sync_anchor ORDER BY video_id, video_t_s'),
    q('SELECT s.video_id, s.method, s.t_start_s, s.t_end_s, s.hash, s.built_at, t.json FROM route_sync s LEFT JOIN sync_track t USING (video_id) WHERE s.method = \'anchors\' OR s.path LIKE \'api/sync/%\''),
    q('SELECT * FROM collection ORDER BY position, collection_id'),
    q('SELECT * FROM collection_item ORDER BY collection_id, position'),
    q('SELECT * FROM channel_optout'),
    q('SELECT image_id, video_id, kind, r2_key, mime, bytes, width, height, rights, credit, uploaded_by, uploaded_at, is_primary FROM video_image'),
    q('SELECT * FROM edit_log ORDER BY id'),
    q('SELECT * FROM localization_log ORDER BY at'),
  ]);
  const fields = new Map();
  for (const m of manual) { if (!fields.has(m.video_id)) fields.set(m.video_id, []); fields.get(m.video_id).push(m.field); }
  const lines = [{ type: 'meta', exported_at: now(), rules_version: LOC_RULES.version, format: 1 }];
  for (const v of videos) {
    const mf = fields.get(v.video_id) ?? [];
    lines.push({ type: 'video', video_id: v.video_id,
      editorial: { stars: v.stars, editors_pick: !!v.editors_pick, editor_note: v.editor_note, hidden: !!v.hidden, site_published: !!v.site_published },
      manual: Object.fromEntries(mf.filter((f) => f in v).map((f) => [f, v[f]])), manual_fields: mf });
  }
  for (const r of routes) lines.push({ type: 'route', video_id: r.video_id, discarded: !!r.discarded, method: r.method, distance_km: r.distance_km,
    via: parse(r.manual_via), line: parse(r.polyline)?.map(([la, lo]) => [lo, la]) ?? null, profile: parse(r.profile) });
  for (const l of locs) lines.push({ type: 'localization', ...l, gates: parse(l.gates), check_points: parse(l.check_points) });
  for (const a of anchors) lines.push({ type: 'anchor', ...a });
  for (const s of syncs) { const { json, ...rest } = s; lines.push({ type: 'sync', ...rest, track: parse(json) }); }
  for (const c of cols) lines.push({ type: 'collection', ...c, items: items.filter((i) => i.collection_id === c.collection_id) });
  for (const o of opt) lines.push({ type: 'optout', ...o });
  for (const i of imgs) lines.push({ type: 'image', ...i });
  for (const e of log) lines.push({ type: 'edit', ...e, old: parse(e.old), new: parse(e.new) });
  for (const e of loclog) lines.push({ type: 'localization_log', ...e });
  return new Response(lines.map((x) => JSON.stringify(x)).join('\n') + '\n', { headers: { 'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow', 'content-disposition': 'attachment; filename="manual.ndjson"' } });
}

/** /api/admin/* — `who` is the verified identity. */
export async function handleAdmin(request, env, who, ctx) {
  const url = new URL(request.url), m = request.method, origin = url.origin + basePath(env); // site base, e.g. https://ridrs.app/scenic
  const parts = url.pathname.slice(basePath(env).length).replace(/^\/api\/admin\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const [a, b, c, d] = parts;
  if (a === 'me' && m === 'GET') {
    const [regions, countries] = await env.DB.batch([
      env.DB.prepare('SELECT region, count(*) AS n FROM video WHERE region IS NOT NULL GROUP BY region ORDER BY n DESC'),
      env.DB.prepare('SELECT country, max(country_name) AS name FROM video WHERE country IS NOT NULL GROUP BY country ORDER BY name'),
    ]);
    return ajson({ email: who.email, via: who.via, regions: regions.results.map((r) => r.region), countries: countries.results, rules: LOC_RULES.version,
      images: !!env.IMAGES });
  }
  if (a === 'videos' && !b && m === 'GET') return ajson(await listVideos(env, url));
  if (a === 'videos' && b) {
    if (!ID.test(b)) bad('Ungültige Video-ID');
    if (!c && m === 'GET') return ajson(await videoDetail(env, b, origin));
    if (!c && m === 'PATCH') return ajson(await patchVideo(env, who.email, b, await readJson(request)));
    if (c === 'anchors' && !d && m === 'POST') return ajson(await addAnchor(env, who.email, b, await readJson(request), origin));
    if (c === 'anchors' && d && m === 'DELETE') {
      const r = await change(env, who.email, 'anchor', b, String(+d), null);
      return ajson({ ...r, sync: await recomputeSync(env, b, who.email, origin) });
    }
    if (c === 'resync' && m === 'POST') return ajson(await recomputeSync(env, b, who.email, origin));
    if (c === 'track' && m === 'GET') {
      const sync = await env.DB.prepare('SELECT * FROM route_sync WHERE video_id = ?1').bind(b).first();
      return ajson(await loadTrack(env, b, sync, origin));
    }
    if (c === 'route' && m === 'PUT') return ajson(await editRoute(env, who.email, b, await readJson(request), origin));
    if (c === 'review' && m === 'POST') return ajson(await review(env, who.email, b, await readJson(request), origin));
    if (c === 'images' && m === 'POST') return ajson(await uploadImage(env, who.email, b, request));
    if (c === 'video2gpx-job.json' && m === 'GET') {
      const j = await loadJob(env, b, origin);
      if (!j) throw new HttpError(404, 'Video nicht gefunden');
      return new Response(JSON.stringify(j.job, null, 2) + '\n', { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
        'x-robots-tag': 'noindex, nofollow', 'content-disposition': `attachment; filename="${b}.v2g.json"` } });
    }
    if (c === 'video2gpx' && m === 'POST') return ajson(await uploadResult(env, who.email, b, request, origin));
  }
  if (a === 'osrm' && m === 'POST') return ajson(await osrmRoute((await readJson(request)).points));
  if (a === 'images' && b) {
    if (!c && m === 'PATCH') return ajson(await patchImage(env, who.email, b, await readJson(request)));
    if (!c && m === 'DELETE') return ajson(await deleteImage(env, who.email, b));
    if (c === 'raw' && m === 'GET') {
      const img = await env.DB.prepare('SELECT r2_key, mime FROM video_image WHERE image_id = ?1').bind(b).first();
      const obj = img && (await env.IMAGES?.get(img.r2_key));
      if (!obj) throw new HttpError(404, 'Bild nicht gefunden');
      return new Response(obj.body, { headers: { 'content-type': img.mime, 'cache-control': 'private, max-age=3600' } });
    }
  }
  if (a === 'collections') {
    if (!b && m === 'GET') return ajson(await collections(env));
    return ajson(await collectionWrite(env, who.email, m, parts.slice(1), m === 'DELETE' ? {} : await readJson(request)));
  }
  if (a === 'optout') {
    if (!b && m === 'GET') return ajson(await optouts(env));
    if (!b && m === 'POST') {
      const body = await readJson(request);
      if (!/^UC[\w-]{22}$/.test(body.channel_id || '')) bad('Kanal-ID (UC…, 24 Zeichen)');
      return ajson(await change(env, who.email, 'optout', null, body.channel_id, { requested_at: now().slice(0, 10), note: str(500)(body.note) }));
    }
    if (b && m === 'DELETE') return ajson(await change(env, who.email, 'optout', null, b, null));
  }
  if (a === 'log' && !b && m === 'GET') {
    const vid = url.searchParams.get('video_id'), before = +url.searchParams.get('before') || 1e15;
    const { results } = await (vid
      ? env.DB.prepare('SELECT e.*, v.title FROM edit_log e LEFT JOIN video v USING (video_id) WHERE e.video_id = ?1 AND e.id < ?2 ORDER BY e.id DESC LIMIT 100').bind(vid, before)
      : env.DB.prepare('SELECT e.*, v.title FROM edit_log e LEFT JOIN video v USING (video_id) WHERE e.id < ?1 ORDER BY e.id DESC LIMIT 100').bind(before)).all();
    return ajson(results.map((x) => ({ ...x, old: parse(x.old), new: parse(x.new) })));
  }
  if (a === 'log' && b && c === 'undo' && m === 'POST') return ajson(await undo(env, who.email, +b, origin));
  if (a === 'export' && m === 'GET') return exportManual(env);
  throw new HttpError(404, 'Unbekannter Admin-Pfad');
}
