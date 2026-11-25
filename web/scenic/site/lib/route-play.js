// SPDX-License-Identifier: AGPL-3.0-or-later
// Route player (site/route.js, ROUTE-PLAYER-PLAN.md): one clock for a whole route. The route is cut into segments by its video
// assignments (GET api/tracks/:id). A video segment runs on its video's time: the synced track between t_from_s and t_to_s is
// projected onto the route, which gives km <-> video second both ways. A gap (no playable video) runs on the speed model of
// site/lib/route-sync.js. Every segment holds K (km along the route) and S (seconds since the segment's start), both rising; the
// route clock is the segment's start c0 plus S, and in a video segment the video time is t_from + S.
// Also the timing rules of the two-player handover (site/route-deck.js): when to buffer the next video, when to start it.
// Pure functions without DOM or I/O, checked by test/route-play.test.mjs.
import { kmAlong, pointAt, speedModel, trackAt } from './route-sync.js';
import { joinSegments, projectNear } from './track-cover.js';

export const PLAY = {
  /** The next video is buffered this many seconds before its segment starts (or at the start of a shorter segment). */
  preloadS: 30,
  /** Two assignments of the same video count as one when the second starts within this many seconds of the first's end. */
  continuousS: 1,
  /** A synced track point further off the route than this does not count for the km mapping. */
  maxOffM: 200,
  /** Below this share of usable track points, or of the segment's km reached, the mapping is linear between both ends. */
  minShare: 0.5,
  /** Start latency assumed for a buffered YouTube player before one was measured (s). */
  latencyS: 0.25,
  /** Speed factors for gaps (the black box). */
  gapRates: [1, 4, 16],
};

const interp = (X, Y, x) => {
  const n = X.length - 1;
  if (n < 1) return Y[0];
  if (x <= X[0]) return Y[0];
  if (x >= X[n]) return Y[n];
  let lo = 0, hi = n;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (X[mid] <= x) lo = mid; else hi = mid; }
  const d = X[hi] - X[lo];
  return Y[lo] + (d ? (x - X[lo]) / d : 0) * (Y[hi] - Y[lo]);
};

/** Strictly rising copies of K and S for km -> S: of a run of equal km (a stop) the first second is kept. */
function inverse(K, S) {
  const k = [K[0]], s = [S[0]];
  for (let i = 1; i < K.length; i++) if (K[i] > k.at(-1) + 1e-9) { k.push(K[i]); s.push(S[i]); }
  return { k, s };
}

/**
 * km <-> seconds of a video segment from its synced track: the track points between t0 and t1 (1 per second, both ends interpolated),
 * each projected onto the route near the km before, km made rising and held inside [a, b]; first point at a, last at b.
 * Falls back to linear between (a, t0) and (b, t1) when too few points lie on the route or they cover too little of it.
 * @returns {{K: number[], S: number[], linear: boolean}}
 */
export function videoMapping(line, cum, track, a, b, t0, t1, opt = PLAY) {
  const linear = { K: [a, b], S: [0, t1 - t0], linear: true };
  if (!track?.t?.length || track.c?.length < 2 || !(t1 > t0)) return linear;
  const ts = [t0];
  for (const t of track.t) if (t > t0 && t < t1) ts.push(t);
  ts.push(t1);
  const K = [], S = [];
  let km = a, ok = 0;
  for (const t of ts) {
    const p = projectNear(line, cum, trackAt(track, t), km, Math.max(0.5, (b - a) * 0.1));
    if (p.dist_m <= opt.maxOffM) { ok++; km = Math.min(b, Math.max(km, p.km)); }
    K.push(km); S.push(t - t0);
  }
  K[0] = a; K[K.length - 1] = b;
  for (let i = 1; i < K.length; i++) if (K[i] < K[i - 1]) K[i] = K[i - 1];
  const reach = K.at(-2) ?? a;
  if (ok / ts.length < opt.minShare || (b > a && (reach - a) / (b - a) < opt.minShare)) return linear;
  return { K, S, linear: false };
}

/** km <-> seconds of a gap from the speed model of the whole route ({K, T}). */
function gapMapping(model, a, b) {
  const T0 = interp(model.K, model.T, a), K = [a], S = [0];
  for (let i = 0; i < model.K.length; i++) if (model.K[i] > a && model.K[i] < b) { K.push(model.K[i]); S.push(model.T[i] - T0); }
  K.push(b); S.push(Math.max(S.at(-1) + 1e-3, interp(model.K, model.T, b) - T0));
  return { K, S, linear: false };
}

/**
 * Assignments [{from_km, video_id, t_from_s, t_to_s}] (as GET api/tracks/:id returns them) with their end, a gap before the first,
 * and continuous assignments of one video merged.
 */
export function normalize(assignments, totalKm, opt = PLAY) {
  const list = [...(assignments ?? [])].filter((x) => x.from_km < totalKm).sort((x, y) => x.from_km - y.from_km);
  if (!list.length || list[0].from_km > 1e-6) list.unshift({ from_km: 0, video_id: null });
  const out = [];
  for (const x of list) {
    const v = x.video_id && x.t_from_s != null && x.t_to_s != null && x.t_to_s > x.t_from_s ? x.video_id : null;
    const s = { from_km: Math.max(0, x.from_km), video_id: v, t_from: v ? x.t_from_s : null, t_to: v ? x.t_to_s : null };
    const prev = out.at(-1);
    if (prev && !prev.video_id && !v) continue;
    if (prev && v && prev.video_id === v && Math.abs(s.t_from - prev.t_to) <= opt.continuousS) { prev.t_to = s.t_to; prev.merged = true; continue; }
    out.push(s);
  }
  return out.map((s, i) => ({ ...s, to_km: i + 1 < out.length ? out[i + 1].from_km : totalKm }));
}

/**
 * The route timeline.
 * @param {{line: number[][][]|number[][], profile?: number[][]|null, segments: object[], tracks?: Map<string, {t:number[], c:number[][]}>|object}} o
 *   line: the route's stored segments (or one line); tracks: the synced track per video id. A video without a track plays linearly.
 * @returns {{line, cum, km: number, dur: number, segs: {i, from_km, to_km, video_id, t_from, t_to, c0, dur, K, S, k, s, linear}[]}}
 */
export function buildTimeline({ line, profile = null, segments, tracks = new Map() }, opt = PLAY) {
  const ln = Array.isArray(line?.[0]?.[0]) ? joinSegments(line) : line, cum = kmAlong(ln), km = cum.at(-1);
  const get = (id) => (tracks instanceof Map ? tracks.get(id) : tracks?.[id]) ?? null;
  const model = speedModel(ln, cum, profile);
  let c0 = 0;
  const segs = normalize(segments, km, opt).map((s, i) => {
    const m = s.video_id ? videoMapping(ln, cum, get(s.video_id), s.from_km, s.to_km, s.t_from, s.t_to, opt) : gapMapping(model, s.from_km, s.to_km);
    const dur = m.S.at(-1), seg = { i, ...s, c0, dur, K: m.K, S: m.S, ...inverse(m.K, m.S), linear: m.linear };
    c0 += dur;
    return seg;
  });
  return { line: ln, cum, km, dur: c0, segs };
}

/** The segment holding km (the last one at the route's end). */
export function segAtKm(tl, km) {
  const s = tl.segs;
  let lo = 0, hi = s.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (s[mid].from_km <= km) lo = mid; else hi = mid - 1; }
  return s[lo];
}
/** The segment holding clock c. */
export function segAtClock(tl, c) {
  const s = tl.segs;
  let lo = 0, hi = s.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (s[mid].c0 <= c) lo = mid; else hi = mid - 1; }
  return s[lo];
}
/** Seconds into segment seg at km. */
export const sAtKm = (seg, km) => interp(seg.k, seg.s, Math.max(seg.from_km, Math.min(seg.to_km, km)));
/** km at seconds s into segment seg. */
export const kmAtS = (seg, s) => interp(seg.S, seg.K, Math.max(0, Math.min(seg.dur, s)));
export const clockAtKm = (tl, km) => { const seg = segAtKm(tl, km); return seg.c0 + sAtKm(seg, km); };
export const kmAtClock = (tl, c) => { const seg = segAtClock(tl, c); return kmAtS(seg, c - seg.c0); };
/** Video second of a video segment at km. */
export const videoTimeAtKm = (seg, km) => seg.t_from + sAtKm(seg, km);
/** Position [lon, lat] at km. */
export const pointAtKm = (tl, km) => pointAt(tl.line, tl.cum, Math.max(0, Math.min(tl.km, km)));

/** The next segment that has a video, after segment index i (skipping one gap), or null. */
export function nextVideo(tl, i) {
  for (let j = i + 1; j < tl.segs.length && j <= i + 2; j++) if (tl.segs[j].video_id) return tl.segs[j];
  return null;
}

/**
 * What the deck must have ready at clock c: the segment playing and the next video segment to buffer, when its start is at most
 * preloadS away (from the playing segment's start on, if that one is shorter).
 * @returns {{seg, preload: object|null}}
 */
export function deckPlan(tl, c, opt = PLAY) {
  const seg = segAtClock(tl, c), next = nextVideo(tl, seg.i);
  const preload = next && (next.c0 - c <= opt.preloadS || next.c0 - seg.c0 <= opt.preloadS) ? next : null;
  return { seg, preload };
}

/**
 * Handover: the clock at which the hidden player must be told to play so that its first frame comes at the next segment's start,
 * given its measured start latency (s of video time; the clock runs at the video's rate in a video segment).
 */
export const startAt = (next, latencyS = PLAY.latencyS, rate = 1) => next.c0 - latencyS * rate;
