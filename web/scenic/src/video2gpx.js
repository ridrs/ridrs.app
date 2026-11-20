// SPDX-License-Identifier: AGPL-3.0-or-later
// video2gpx round trip (VIDEO2GPX-INTEGRATION.md, steps A/B, contract in section 8):
//   job      GET /api/videos/<id>/video2gpx-job.json (public) and GET /api/admin/videos/<id>/video2gpx-job.json (admin, also hidden videos)
//            -> the desktop app video2gpx opens it as <id>.v2g.json and creates a project with these hints.
//   result   POST /api/admin/videos/<id>/video2gpx with the app's <id>.scenic.json (admin upload, same-origin, Access + CSRF guard as
//            every admin write) -> validated, stored as sync_track (route_sync.method video2gpx), Lokalisierungsstufe 2.
// The pure parts (bbox, job, validation, route agreement) are exported for test/video2gpx.test.mjs.
import { kmAlong, project } from '../site/lib/route-sync.js';

/** Search frame around a route: its bounding box plus this margin (the app's own margin around a route hint, mapPanel HINT_MARGIN_KM). */
export const ROUTE_MARGIN_KM = 3;
/** Search frame around a pin without a route: a 60 x 60 km square (the app's frame suggested from a title, mapPanel suggestFromTitle). */
export const PIN_HALF_KM = 30;
/** Start and end frames: the route ends ± this many metres (only for a confirmed route, level 4 or better). */
export const END_HALF_M = 300;
/** Upload limits: request body and points (4 h at one point per second). */
export const MAX_RESULT_BYTES = 1_500_000;
export const MAX_POINTS = 14_400;
/** Fastest plausible speed between two points (m/s, 252 km/h); a jump is allowed only at a scene cut. */
export const MAX_SPEED_MS = 70;
/** Above this median distance to the Scenic route the admin offers "Route aus video2gpx übernehmen" (plan section 5). */
export const ROUTE_OFFER_M = 50;
const AGREEMENT_SAMPLES = 600;

const KM_PER_DEG_LAT = 111.32;
const r6 = (x) => Math.round(x * 1e6) / 1e6;
const r1 = (x) => Math.round(x * 10) / 10;
const fail = (status, message) => { const e = new Error(message); e.status = status; throw e; };
const bad = (message) => fail(400, message);
const parse = (s) => { try { return s == null ? null : JSON.parse(s); } catch { return null; } };

/** {south, west, north, east} of a line [[lon, lat], …]. */
export function lineBbox(line) {
  let south = 90, west = 180, north = -90, east = -180;
  for (const [lo, la] of line) { south = Math.min(south, la); north = Math.max(north, la); west = Math.min(west, lo); east = Math.max(east, lo); }
  return { south, west, north, east };
}
/** A bbox grown by km on every side, rounded outwards to 6 decimals. */
export function growBbox(b, km) {
  const dLat = km / KM_PER_DEG_LAT, dLon = km / (KM_PER_DEG_LAT * Math.cos((((b.south + b.north) / 2) * Math.PI) / 180));
  const dn = (x) => Math.floor(x * 1e6) / 1e6, up = (x) => Math.ceil(x * 1e6) / 1e6;
  return { south: dn(Math.max(-90, b.south - dLat)), west: dn(Math.max(-180, b.west - dLon)), north: up(Math.min(90, b.north + dLat)), east: up(Math.min(180, b.east + dLon)) };
}
const around = ([lon, lat], km) => growBbox({ south: lat, west: lon, north: lat, east: lon }, km);
export const inBbox = (b, [lon, lat]) => lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east;

/** Route level of the hint: 4 (confirmed; also for levels 1-3, which need a confirmed route) or 5 (approximate). */
export function routeLevelOf(loc) {
  const l = parse(loc?.gates)?.route ?? loc?.loc_level ?? 4;
  return l <= 4 ? 4 : 5;
}

/**
 * The job of a video (contract: VIDEO2GPX-INTEGRATION.md section 8.1). `line` is the full route line [[lon, lat], …] or null.
 * @returns {object} exactly the fields of the contract
 */
export function buildJob({ v, tech, route, loc, line, base }) {
  const id = v.video_id;
  const hasRoute = !!(route && line?.length > 1);
  const level = hasRoute ? routeLevelOf(loc) : null;
  const bbox = hasRoute ? growBbox(lineBbox(line), ROUTE_MARGIN_KM) : v.lat != null && v.lon != null ? around([v.lon, v.lat], PIN_HALF_KM) : null;
  const ends = hasRoute && level <= 4;
  const gpx = hasRoute && route.gpx_path ? `${base}/${route.gpx_path.replace(/^\//, '')}` : null;
  return {
    video_id: id,
    url: `https://www.youtube.com/watch?v=${id}`,
    title: v.title ?? null,
    channel: v.channel_name ?? null,
    duration_s: v.duration_s ?? null,
    fps: tech?.fps ?? null,
    country: v.country ?? null,
    vehicle: v.vehicle ?? null,
    route_gpx: gpx,
    route_level: gpx ? level : null,
    bbox,
    start_bbox: ends ? around(line[0], END_HALF_M / 1000) : null,
    end_bbox: ends ? around(line.at(-1), END_HALF_M / 1000) : null,
    scenic: { base, video_id: id },
  };
}

const dist = (a, b) => { const k = Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180);
  return Math.hypot((b[0] - a[0]) * k, b[1] - a[1]) * KM_PER_DEG_LAT * 1000; };
const median = (xs) => { const s = [...xs].sort((a, b) => a - b), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };

/** Distance of the track to the route line: median and max in metres over up to 600 evenly spread points, or null without a route. */
export function routeAgreement(line, c, samples = AGREEMENT_SAMPLES) {
  if (!line || line.length < 2 || !c?.length) return null;
  const cum = kmAlong(line), step = Math.max(1, c.length / samples), d = [];
  for (let i = 0; i < c.length; i += step) d.push(project(line, cum, c[Math.floor(i)]).dist_m);
  return { median_m: r1(median(d)), max_m: r1(Math.max(...d)), samples: d.length };
}

const num = (x) => typeof x === 'number' && Number.isFinite(x);
const VERDICTS = ['confident', 'uncertain'];

/**
 * Validates an uploaded result against the video's job (plan section 5): id, t strictly increasing, plausible speeds (a jump only at a
 * scene cut), every point inside the job's bbox, size limits, a complete checklist. Throws {status, message} (German) on the first problem.
 * @returns {{track: {v: 1, t: number[], c: number[][], e?: number[]}, t_start: number, t_end: number}}
 */
export function validateResult(p, job, { durationS = null } = {}) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) bad('Kein video2gpx-Ergebnis (JSON-Objekt erwartet)');
  if (p.video_id !== job.video_id) bad(`Die Datei gehört zu Video ${String(p.video_id).slice(0, 20)}, nicht zu ${job.video_id}`);
  if (typeof p.pipeline_hash !== 'string' || !/^[\w.-]{1,64}$/.test(p.pipeline_hash)) bad('pipeline_hash fehlt');
  if (!VERDICTS.includes(p.verdict)) bad(p.verdict === 'no_route' ? 'video2gpx hat keine Route gefunden (verdict no_route)' : 'verdict fehlt oder ist unbekannt');
  const { t, c, e } = p;
  if (!Array.isArray(t) || !Array.isArray(c) || t.length !== c.length) bad('t und c fehlen oder sind verschieden lang');
  if (t.length < 2) bad('Zu wenige Punkte');
  if (t.length > MAX_POINTS) fail(413, `Höchstens ${MAX_POINTS} Punkte (4 Stunden)`);
  if (e != null && (!Array.isArray(e) || e.length !== t.length || !e.every(num))) bad('e muss so lang wie t sein und nur Zahlen enthalten');
  const cuts = Array.isArray(p.cuts) ? p.cuts.filter(num) : [];
  for (let i = 0; i < t.length; i++) {
    const ti = t[i], ci = c[i];
    if (!num(ti) || ti < 0) bad(`t[${i}] ist keine Videozeit`);
    if (i && !(ti > t[i - 1])) bad(`t muss streng steigen (bei ${ti} s)`);
    if (!Array.isArray(ci) || ci.length !== 2 || !num(ci[0]) || !num(ci[1]) || Math.abs(ci[0]) > 180 || Math.abs(ci[1]) > 90) bad(`c[${i}] ist kein [lon, lat]`);
    if (job.bbox && !inBbox(job.bbox, ci)) bad(`Punkt bei ${ti} s liegt außerhalb des Suchrahmens der Job-Datei`);
    if (i) {
      const dt = ti - t[i - 1], v = dist(c[i - 1], ci) / dt;
      if (v > MAX_SPEED_MS && !cuts.some((x) => x >= t[i - 1] - 1 && x <= ti + 1)) bad(`Unplausible Geschwindigkeit ${Math.round(v * 3.6)} km/h bei ${ti} s`);
    }
  }
  if (durationS && t.at(-1) > durationS + 2) bad(`t endet bei ${t.at(-1)} s, das Video ist nur ${durationS} s lang`);
  if (!num(p.t_start) || !num(p.t_end) || !(p.t_start < p.t_end)) bad('t_start und t_end fehlen');
  const qc = p.qc;
  if (!qc || typeof qc !== 'object' || !Array.isArray(qc.checks) || !qc.checks.length) bad('qc fehlt');
  // every blocking check green, or overridden with a note (route agreement is shown, not blocking: blocking false)
  const open = qc.checks.filter((x) => !x || (x.blocking !== false && !x.ok && !(x.overridden && typeof x.note === 'string' && x.note.trim())));
  if (open.length) bad(`Prüfliste nicht vollständig: ${open.map((x) => x?.id ?? '?').join(', ')}`);
  const track = { v: 1, t: t.map((x) => Math.round(x * 1000) / 1000), c: c.map(([lo, la]) => [r6(lo), r6(la)]) };
  if (e) track.e = e.map(r1);
  return { track, t_start: p.t_start, t_end: p.t_end };
}

/** What of the payload ridrs Scenic keeps beside the track (localization.gates.video2gpx); checked_by is the uploader's identity. */
export function resultMeta(p, who) {
  const str = (x, n) => (typeof x === 'string' ? x.slice(0, n) : null);
  const qc = p.qc ?? {};
  return {
    pipeline_hash: p.pipeline_hash, app_version: str(p.app_version, 40), vehicle: str(p.vehicle, 20), offset_m: num(p.offset_m) ? p.offset_m : null,
    verdict: p.verdict, verdict_basis: str(p.verdict_basis, 300), confidence_mean: num(p.confidence_mean) ? p.confidence_mean : null,
    coverage: num(p.coverage) ? p.coverage : null, route_km: num(p.route_km) ? p.route_km : null,
    t_start: p.t_start, t_end: p.t_end, cuts: Array.isArray(p.cuts) ? p.cuts.filter(num).slice(0, 500) : [],
    standstills: Array.isArray(p.standstills) ? p.standstills.filter((x) => Array.isArray(x) && num(x[0]) && num(x[1])).slice(0, 2000) : [],
    qc: { checks: qc.checks.slice(0, 20).map((x) => ({ id: str(x.id, 40), ok: !!x.ok, blocking: x.blocking !== false, overridden: !!x.overridden, note: str(x.note, 1000), value: x.value ?? null })),
      note: str(qc.note, 2000), checked_by: who },
  };
}

/** Lokalisierungsstufe of an uploaded track: 2, or 1 when the same track (hash) was already verified in the Prüfmodus. */
export function uploadLevel(loc, hash) {
  return loc?.loc_level === 1 && loc.verified_hash === hash ? 1 : 2;
}
