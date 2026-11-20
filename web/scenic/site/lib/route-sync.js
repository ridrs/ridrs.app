// SPDX-License-Identifier: AGPL-3.0-or-later
// Route geometry, speed model, anchor sync and the Lokalisierungsstufe rules for anchors and the
// Prüfmodus (CLOUDFLARE-KONZEPT.md 2.5, 2.7, 3.5). Pure functions without DOM or I/O: the worker
// (src/admin.js) and the admin page (site/admin/admin.js) both use them, and test/route-sync.test.mjs
// checks them under node. Lines are [[lon, lat], …]; km along a line comes from equirectangular
// distances (good to well under 1 % at route scale).

const KM_PER_DEG = 111.32;

/** Rules for anchors and review (concept 2.5). Starting values; bump `version` when they change. */
export const LOC_RULES = {
  version: 1,
  /** An anchor counts as "at the start" or "at the end" within this distance of the route end (km). */
  endToleranceKm: (routeKm) => Math.max(0.5, 0.05 * routeKm),
  /** Level 2 needs on average at least one anchor per this many km (and at least 2 anchors). */
  kmPerAnchor: 10,
  /** Prüfmodus: a check point passes when on the right road and at most this far along the road (m). */
  reviewMaxDevM: 25,
  reviewMinPoints: 10,
};

const dist = (a, b) => { const k = Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180);
  return Math.hypot((b[0] - a[0]) * k, b[1] - a[1]) * KM_PER_DEG; };

/** Cumulative km at each vertex. */
export function kmAlong(line) {
  const out = new Array(line.length); out[0] = 0;
  for (let i = 1; i < line.length; i++) out[i] = out[i - 1] + dist(line[i - 1], line[i]);
  return out;
}

/** Position at km along the line (clamped to its ends). */
export function pointAt(line, cum, km) {
  if (km <= 0) return line[0];
  const n = line.length - 1;
  if (km >= cum[n]) return line[n];
  let lo = 0, hi = n;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= km) lo = mid; else hi = mid; }
  const d = cum[hi] - cum[lo], f = d ? (km - cum[lo]) / d : 0, a = line[lo], b = line[hi];
  return [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])];
}

/** Nearest point on the line to p: {km along the line, point [lon, lat], dist_m off the line}. */
export function project(line, cum, p) {
  let best = { km: 0, point: line[0], dist_m: Infinity };
  const k = Math.cos((p[1] * Math.PI) / 180);
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i];
    const ax = (b[0] - a[0]) * k, ay = b[1] - a[1], px = (p[0] - a[0]) * k, py = p[1] - a[1];
    const l2 = ax * ax + ay * ay, f = l2 ? Math.max(0, Math.min(1, (px * ax + py * ay) / l2)) : 0;
    const d = Math.hypot(px - f * ax, py - f * ay) * KM_PER_DEG * 1000;
    if (d < best.dist_m) best = { km: cum[i - 1] + f * (cum[i] - cum[i - 1]), point: [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])], dist_m: d };
  }
  return best;
}

/** Elevation at km from a profile [[km, ele], …] whose km run over `profileKm` instead of the line's length. */
export function eleAt(profile, km) {
  if (!profile?.length) return null;
  if (km <= profile[0][0]) return profile[0][1];
  for (let i = 1; i < profile.length; i++) {
    if (profile[i][0] >= km) { const [a, b] = [profile[i - 1], profile[i]]; return a[1] + ((km - a[0]) / ((b[0] - a[0]) || 1)) * (b[1] - a[1]); }
  }
  return profile.at(-1)[1];
}

/**
 * Speed model (concept 2.7): expected speed every 25 m from the curve radius (lateral acceleration 2 m/s²,
 * 15–90 km/h), slower on climbs above 3 %, with acceleration (1 m/s²) and braking (1.5 m/s²) limits so the
 * car slows down before a hairpin. No road class per point yet (the pipeline has only shares), so straight
 * roads cap at 90 km/h. Returns sample km K and the cumulative model time T in seconds.
 */
export function speedModel(line, cum, profile = null) {
  const total = cum.at(-1), STEP = 0.025;
  const n = Math.max(2, Math.ceil(total / STEP) + 1);
  const K = new Float64Array(n), P = new Array(n), V = new Float64Array(n), T = new Float64Array(n);
  for (let j = 0; j < n; j++) { K[j] = Math.min(total, j * STEP); P[j] = pointAt(line, cum, K[j]); }
  const pkm = profile?.length ? profile.at(-1)[0] / (total || 1) : 1;
  const heading = (a, b) => Math.atan2(b[1] - a[1], (b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180));
  for (let j = 0; j < n; j++) {
    const a = P[Math.max(0, j - 2)], m = P[j], b = P[Math.min(n - 1, j + 2)];
    let v = 25; // 90 km/h in m/s
    if (j >= 2 && j < n - 2) {
      let d = Math.abs(heading(m, b) - heading(a, m)); if (d > Math.PI) d = 2 * Math.PI - d;
      if (d > 1e-3) v = Math.min(v, Math.sqrt(2.0 * (50 / d)));
    }
    if (profile?.length) {
      const g = (eleAt(profile, (K[j] + 0.1) * pkm) - eleAt(profile, Math.max(0, K[j] - 0.1) * pkm)) / 200;
      if (g > 0.03) v *= Math.max(0.6, 1 - (g - 0.03) * 5);
    }
    V[j] = Math.max(15 / 3.6, v);
  }
  for (let j = 1; j < n; j++) V[j] = Math.min(V[j], Math.sqrt(V[j - 1] ** 2 + 2 * 1.0 * (K[j] - K[j - 1]) * 1000));
  for (let j = n - 2; j >= 0; j--) V[j] = Math.min(V[j], Math.sqrt(V[j + 1] ** 2 + 2 * 1.5 * (K[j + 1] - K[j]) * 1000));
  for (let j = 1; j < n; j++) T[j] = T[j - 1] + ((K[j] - K[j - 1]) * 1000) / ((V[j - 1] + V[j]) / 2);
  return { K, T, V };
}

const interp = (X, Y, x) => {
  const n = X.length - 1;
  if (x <= X[0]) return Y[0];
  if (x >= X[n]) return Y[n];
  let lo = 0, hi = n;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (X[mid] <= x) lo = mid; else hi = mid; }
  const d = X[hi] - X[lo];
  return Y[lo] + (d ? (x - X[lo]) / d : 0) * (Y[hi] - Y[lo]);
};

/**
 * Snaps anchors to the line and keeps those whose km grows with the video time (20 m tolerance for a stop).
 * @returns {{kept: {t, km, point, dist_m, …}[], dropped: {…}[]}}
 */
export function snapAnchors(line, cum, anchors) {
  const snapped = anchors.map((a) => ({ ...a, ...project(line, cum, [a.lon, a.lat]) })).sort((a, b) => a.t - b.t);
  const kept = [], dropped = [];
  for (const a of snapped) {
    const prev = kept.at(-1);
    if (prev && (a.t - prev.t < 1 || a.km < prev.km - 0.02)) dropped.push(a);
    else kept.push(prev && a.km < prev.km ? { ...a, km: prev.km } : a);
  }
  return { kept, dropped };
}

/**
 * Time-synced track from anchors (concept 2.7, 3.5): between two anchors the time is spread along the route
 * by the speed model (with a constant model this is plain piecewise-linear interpolation in km); before the
 * first and after the last anchor the model runs on, scaled by how fast the video was between the anchors.
 * Without anchors, tStart/tEnd (default 0 and the video duration) act as anchors at the route's start and end:
 * that is the level-3 estimate ("Zeit nur aus Start, Ende und Geschwindigkeitsmodell").
 * @param {{line: number[][], anchors?: {t:number, lon:number, lat:number}[], duration?: number|null,
 *   profile?: number[][]|null, tStart?: number|null, tEnd?: number|null}} o
 * @returns {{track: {v:1, t:number[], c:number[][], e?:number[]}, anchors: object[], dropped: object[], factor: number, routeKm: number}|null}
 */
export function buildTrack({ line, anchors = [], duration = null, profile = null, tStart = null, tEnd = null }) {
  if (!line || line.length < 2) return null;
  const cum = kmAlong(line), total = cum.at(-1);
  if (!(total > 0)) return null;
  const { K, T } = speedModel(line, cum, profile);
  const mt = (km) => interp(K, T, km), kmAtM = (m) => interp(T, K, m), Tmax = T[T.length - 1];
  const { kept, dropped } = snapAnchors(line, cum, anchors);
  let A = kept;
  if (!A.length) {
    const t1 = tEnd ?? duration;
    if (!(t1 > (tStart ?? 0))) return null;
    A = [{ t: tStart ?? 0, km: 0, synthetic: true }, { t: t1, km: total, synthetic: true }];
  }
  const first = A[0], last = A.at(-1);
  let factor = 1;
  if (A.length > 1 && mt(last.km) - mt(first.km) > 1) factor = Math.max(0.25, Math.min(4, (last.t - first.t) / (mt(last.km) - mt(first.km))));
  const kmAtT = (t) => {
    if (t <= first.t) return kmAtM(mt(first.km) - (first.t - t) / factor);
    if (t >= last.t) return kmAtM(mt(last.km) + (t - last.t) / factor);
    let i = 0; while (A[i + 1].t < t) i++;
    const a = A[i], b = A[i + 1], ma = mt(a.km), mb = mt(b.km);
    return kmAtM(ma + ((t - a.t) / (b.t - a.t)) * (mb - ma));
  };
  const t0 = first.synthetic ? first.t : first.t - mt(first.km) * factor;
  const t1 = last.synthetic ? last.t : last.t + (Tmax - mt(last.km)) * factor;
  const from = Math.max(0, Math.ceil(t0)), to = Math.floor(duration != null ? Math.min(duration, t1) : t1);
  if (to <= from) return null;
  const pkm = profile?.length ? profile.at(-1)[0] / total : 1;
  const r6 = (x) => Math.round(x * 1e6) / 1e6;
  const t = [], c = [], e = [];
  for (let s = from; s <= to; s++) {
    const km = Math.max(0, Math.min(total, kmAtT(s)));
    const p = pointAt(line, cum, km);
    t.push(s); c.push([r6(p[0]), r6(p[1])]);
    if (profile?.length) e.push(Math.round(eleAt(profile, km * pkm) * 10) / 10);
  }
  const track = { v: 1, t, c };
  if (e.length) track.e = e;
  return { track, anchors: kept, dropped, factor, routeKm: total };
}

/**
 * Lokalisierungsstufe from manual anchors (concept 2.5). The route must be level 4 or better (weakest link);
 * level 2 needs anchors at the start and at the end (within LOC_RULES.endToleranceKm) and at least
 * max(2, ceil(routeKm / 10)) anchors; fewer anchors give level 3.
 * @returns {{level:number, key:string, reason:string, need:number, hasStart:boolean, hasEnd:boolean}}
 */
export function anchorLevel({ routeLevel, routeKm, anchorKms }) {
  const tol = LOC_RULES.endToleranceKm(routeKm), need = Math.max(2, Math.ceil(routeKm / LOC_RULES.kmPerAnchor));
  const hasStart = anchorKms.some((k) => k <= tol), hasEnd = anchorKms.some((k) => k >= routeKm - tol);
  const base = { need, hasStart, hasEnd };
  if (routeLevel == null || routeLevel > 4) return { ...base, level: routeLevel ?? 7, key: KEYS[routeLevel ?? 7], reason: 'route' };
  if (!anchorKms.length) return { ...base, level: routeLevel, key: KEYS[routeLevel], reason: 'no_anchors' };
  if (hasStart && hasEnd && anchorKms.length >= need) return { ...base, level: 2, key: 'anchored', reason: 'anchors' };
  return { ...base, level: 3, key: 'estimated', reason: !hasStart ? 'no_start_anchor' : !hasEnd ? 'no_end_anchor' : 'too_few_anchors' };
}
export const KEYS = { 1: 'verified', 2: 'anchored', 3: 'estimated', 4: 'route', 5: 'route_rough', 6: 'point', 7: 'region' };

/** Interpolated position of a track ({t, c}) at video second s. */
export function trackAt(track, s) {
  const { t, c } = track, n = t.length - 1;
  if (s <= t[0]) return c[0];
  if (s >= t[n]) return c[n];
  let lo = 0, hi = n;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (t[mid] <= s) lo = mid; else hi = mid; }
  const f = (s - t[lo]) / (t[hi] - t[lo]);
  return [c[lo][0] + f * (c[hi][0] - c[lo][0]), c[lo][1] + f * (c[hi][1] - c[lo][1])];
}

/**
 * Check points for the Prüfmodus (concept 2.5): evenly over the track time, at least 10 (one per 3 minutes,
 * up to 20), plus up to 6 hairpins (curve radius under 30 m on the route). Junctions are not in the data yet.
 * @returns {number[]} video seconds, sorted
 */
export function checkPoints(track, line) {
  const t0 = track.t[0], t1 = track.t.at(-1), span = t1 - t0;
  if (span <= 0) return [];
  const n = Math.max(LOC_RULES.reviewMinPoints, Math.min(20, Math.round(span / 180)));
  const pts = Array.from({ length: n }, (_, i) => Math.round(t0 + ((i + 0.5) / n) * span));
  if (line?.length > 2) {
    const cum = kmAlong(line), { K, V } = speedModel(line, cum);
    const tight = [];
    const HAIRPIN = Math.sqrt(2 * 30); // model speed in a 30 m radius curve, m/s
    for (let j = 2; j < V.length - 2; j++) if (V[j] < V[j - 1] && V[j] <= V[j + 1] && V[j] < HAIRPIN) tight.push([V[j], K[j]]);
    // Track km per second (the track's own length, scaled to the route) to find when the car is in the curve.
    const tk = kmAlong(track.c), scale = cum.at(-1) / (tk.at(-1) || 1);
    let added = 0;
    for (const [, km] of tight.sort((a, b) => a[0] - b[0])) {
      if (added >= 6) break;
      const i = tk.findIndex((x) => x * scale >= km);
      if (i > 0 && pts.every((s) => Math.abs(s - track.t[i]) >= 15)) { pts.push(track.t[i]); added++; }
    }
  }
  return pts.sort((a, b) => a - b);
}

/**
 * Evaluates a review: each point {t, wrong_road?, lon?, lat?} where lon/lat is the corrected camera position
 * (absent = confirmed). dev_m is the distance along the route between the track's position at t and the
 * corrected one. Passed when every point is on the right road and within LOC_RULES.reviewMaxDevM.
 */
export function evaluateReview({ line, track, points }) {
  const cum = kmAlong(line);
  const out = points.map((p) => {
    const at = project(line, cum, trackAt(track, p.t));
    let dev = 0;
    if (p.lon != null && p.lat != null) dev = Math.abs(project(line, cum, [p.lon, p.lat]).km - at.km) * 1000;
    const dev_m = Math.round(dev * 10) / 10;
    return { t: p.t, ok: !p.wrong_road && dev_m <= LOC_RULES.reviewMaxDevM, dev_m, wrong_road: !!p.wrong_road,
      ...(p.lon != null ? { lon: p.lon, lat: p.lat } : {}) };
  });
  const devs = out.map((p) => p.dev_m).sort((a, b) => a - b);
  const med = devs.length ? (devs.length % 2 ? devs[(devs.length - 1) / 2] : (devs[devs.length / 2 - 1] + devs[devs.length / 2]) / 2) : null;
  return { points: out, passed: out.length >= LOC_RULES.reviewMinPoints && out.every((p) => p.ok), err_med_m: med, err_max_m: devs.at(-1) ?? null };
}
