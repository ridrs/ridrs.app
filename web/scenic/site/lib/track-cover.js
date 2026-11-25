// SPDX-License-Identifier: AGPL-3.0-or-later
// Route editor (site/admin/route-editor.js): which videos ride along a route uploaded as GPX (tab „Routen“, src/tracks.js), where,
// and in the route's direction; and the list of video assignments along the route (table track_video, migration 0011).
// Pure functions without DOM or I/O, checked by test/track-cover.test.mjs. Lines are [[lon, lat], …]; km along a line come from
// kmAlong (equirectangular, as everywhere in site/lib/route-sync.js).
import { kmAlong, pointAt } from './route-sync.js';

const KM_PER_DEG = 111.32;
const RAD = Math.PI / 180;

/**
 * Matching rules. A route sample counts as ridden by a video when the video's line passes within maxDistM and heads the same way
 * (at most maxAngleDeg apart). Up to gapSamples unmatched samples in a row are bridged (a junction, a bit of noise in the simplified
 * line); longer gaps up to maxGapKm too when the video goes on as far as the route did (hairpins, where the simplified video line
 * cuts the corners); runs shorter than minKm are dropped.
 */
export const COVER = { stepKm: 0.05, maxDistM: 60, maxAngleDeg: 50, gapSamples: 4, maxGapKm: 1, minKm: 0.3 };

/** One line of a track's segments (a multi-segment GPX is ridden as one). */
export const joinSegments = (segments) => segments.flat().map(([lo, la]) => [lo, la]);

/** [minLon, minLat, maxLon, maxLat] */
export function bbox(line) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [lo, la] of line) { if (lo < b[0]) b[0] = lo; if (la < b[1]) b[1] = la; if (lo > b[2]) b[2] = lo; if (la > b[3]) b[3] = la; }
  return b;
}
/** Do two bboxes come within marginKm of each other? */
export function bboxNear(a, b, marginKm) {
  const dLat = marginKm / KM_PER_DEG, dLon = dLat / Math.max(0.05, Math.cos(((a[1] + a[3]) / 2) * RAD));
  return a[0] - dLon <= b[2] && b[0] - dLon <= a[2] && a[1] - dLat <= b[3] && b[1] - dLat <= a[3];
}

/** Unit heading of the line around km (local metres, [east, north]). */
export function headingAt(line, cum, km, spanKm = 0.025) {
  const a = pointAt(line, cum, Math.max(0, km - spanKm)), b = pointAt(line, cum, Math.min(cum.at(-1), km + spanKm));
  const dx = (b[0] - a[0]) * Math.cos(((a[1] + b[1]) / 2) * RAD), dy = b[1] - a[1], l = Math.hypot(dx, dy);
  return l ? [dx / l, dy / l] : [0, 0];
}

/** Samples of the route every stepKm (and its end): {km, p, dir}. */
export function samples(line, cum = kmAlong(line), stepKm = COVER.stepKm) {
  const total = cum.at(-1), n = Math.max(1, Math.ceil(total / stepKm)), out = [];
  for (let i = 0; i <= n; i++) { const km = Math.min(total, i * stepKm); out.push({ km, p: pointAt(line, cum, km), dir: headingAt(line, cum, km) }); }
  return out;
}

/**
 * Where the video line passes each sample in the same direction: km along the video line per sample, NaN where it does not.
 * Of several passes (a loop, a road ridden twice) the one continuing the previous sample wins, else the nearest.
 */
export function matchAlong(smp, vline, vcum = kmAlong(vline), opt = COVER) {
  const out = new Float64Array(smp.length).fill(NaN);
  const minCos = Math.cos(opt.maxAngleDeg * RAD), maxKm = opt.maxDistM / 1000, dDeg = maxKm / KM_PER_DEG;
  const n = vline.length;
  // segment geometry once: bbox in degrees, unit direction
  const seg = [];
  for (let i = 1; i < n; i++) {
    const a = vline[i - 1], b = vline[i], k = Math.cos(((a[1] + b[1]) / 2) * RAD), dx = (b[0] - a[0]) * k, dy = b[1] - a[1], l = Math.hypot(dx, dy);
    if (!l) continue;
    seg.push({ i, a, b, k, dx, dy, l, ux: dx / l, uy: dy / l, minLo: Math.min(a[0], b[0]), maxLo: Math.max(a[0], b[0]), minLa: Math.min(a[1], b[1]), maxLa: Math.max(a[1], b[1]) });
  }
  let prev = NaN, prevKm = NaN;
  for (let j = 0; j < smp.length; j++) {
    const { p, dir, km } = smp[j], dLo = dDeg / Math.max(0.05, Math.cos(p[1] * RAD));
    let best = NaN, bestScore = Infinity;
    for (const s of seg) {
      if (p[0] < s.minLo - dLo || p[0] > s.maxLo + dLo || p[1] < s.minLa - dDeg || p[1] > s.maxLa + dDeg) continue;
      if (s.ux * dir[0] + s.uy * dir[1] < minCos) continue;
      const px = (p[0] - s.a[0]) * s.k, py = p[1] - s.a[1];
      const f = Math.max(0, Math.min(1, (px * s.dx + py * s.dy) / (s.l * s.l)));
      const d = Math.hypot(px - f * s.dx, py - f * s.dy) * KM_PER_DEG;
      if (d > maxKm) continue;
      const vkm = vcum[s.i - 1] + f * (vcum[s.i] - vcum[s.i - 1]);
      // continuing the previous match (expected video km within 0.5 km) beats distance
      const expect = Number.isNaN(prev) ? NaN : prev + (km - prevKm);
      const score = !Number.isNaN(expect) && Math.abs(vkm - expect) < 0.5 ? Math.abs(vkm - expect) * 1e-3 + d * 1e-3 : 1 + d;
      if (score < bestScore) { bestScore = score; best = vkm; }
    }
    out[j] = best;
    if (!Number.isNaN(best)) { prev = best; prevKm = km; }
  }
  return out;
}

/** Runs of matched samples → [{from_km, to_km, v_from_km, v_to_km}] (route km and video-line km). */
export function intervals(smp, vkm, opt = COVER) {
  const out = [];
  let start = -1, last = -1;
  const close = () => {
    if (start < 0) return;
    const iv = { from_km: smp[start].km, to_km: smp[last].km, v_from_km: vkm[start], v_to_km: vkm[last] };
    if (iv.to_km - iv.from_km >= opt.minKm && iv.v_to_km > iv.v_from_km) out.push(iv);
    start = last = -1;
  };
  for (let j = 0; j < smp.length; j++) {
    if (Number.isNaN(vkm[j])) continue;
    // a jump in the video (another pass) or a gap that is too long starts a new run
    if (start >= 0) {
      const dk = smp[j].km - smp[last].km, off = Math.abs(vkm[j] - vkm[last] - dk);
      const bridged = j - last - 1 <= opt.gapSamples ? off <= 0.5 : dk <= opt.maxGapKm && off <= Math.max(0.15, 0.3 * dk);
      if (!bridged) close();
    }
    if (start < 0) start = j;
    last = j;
  }
  close();
  return out;
}

/**
 * Coverage of the route by the video lines: `lines` is {id: [[lon, lat], …]}. Returns [{id, intervals, km}] for every video with
 * at least one interval in the route's direction, `km` the length it covers.
 */
export function coverage(line, lines, opt = COVER) {
  const smp = samples(line, kmAlong(line), opt.stepKm), box = bbox(line), out = [];
  for (const [id, vline] of Object.entries(lines)) {
    if (!vline || vline.length < 2 || !bboxNear(box, bbox(vline), opt.maxDistM / 1000)) continue;
    const c = coverLine(smp, vline, opt);
    if (c) out.push({ id, ...c });
  }
  return out.sort((a, b) => b.km - a.km);
}

/**
 * Coverage of the route samples by one line ({intervals, km}, or null). The editor calls it again with the synced track of a video
 * ({t, c}: c is what the camera really drove, detours included), which is more exact than the video's simplified route line.
 */
export function coverLine(smp, vline, opt = COVER) {
  const vkm = matchAlong(smp, vline, kmAlong(vline), opt), iv = intervals(smp, vkm, opt);
  return iv.length ? { intervals: iv, km: iv.reduce((s, x) => s + x.to_km - x.from_km, 0), vkm } : null;
}

/**
 * Video second at route km from a coverage of the route by a synced track (coverLine(smp, track.c)): the matched km along the track,
 * interpolated between the samples (or carried on from a match up to 4 samples away), turned into time. Unlike timeAt it follows the
 * continuous pass, so a place the video passes twice gets the time of the pass that rides along the route. Null without a match.
 */
export function timeAtKm(track, vkm, smp, km) {
  const n = smp.length;
  let j = 0, lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (smp[mid].km <= km) lo = mid; else hi = mid; }
  j = lo;
  let v = NaN;
  const a = vkm[j], b = vkm[Math.min(n - 1, j + 1)], span = smp[Math.min(n - 1, j + 1)].km - smp[j].km;
  if (Number.isFinite(a) && Number.isFinite(b)) v = a + (span ? (km - smp[j].km) / span : 0) * (b - a);
  for (let d = 0; d <= 4 && Number.isNaN(v); d++) {
    if (Number.isFinite(vkm[j - d])) v = vkm[j - d] + (km - smp[j - d].km);
    else if (j + 1 + d < n && Number.isFinite(vkm[j + 1 + d])) v = vkm[j + 1 + d] - (smp[j + 1 + d].km - km);
  }
  if (Number.isNaN(v)) return null;
  const cum = track.cum ??= kmAlong(track.c);
  if (v <= 0) return track.t[0];
  if (v >= cum.at(-1)) return track.t.at(-1);
  lo = 0; hi = cum.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= v) lo = mid; else hi = mid; }
  const f = cum[hi] - cum[lo] ? (v - cum[lo]) / (cum[hi] - cum[lo]) : 0;
  return Math.round((track.t[lo] + f * (track.t[hi] - track.t[lo])) * 10) / 10;
}

/** Videos riding the route at km: [{id, iv}] with the interval that holds km. */
export function videosAt(cov, km, tolKm = 1e-6) {
  const out = [];
  for (const c of cov) { const iv = c.intervals.find((x) => x.from_km - tolKm <= km && km <= x.to_km + tolKm); if (iv) out.push({ id: c.id, iv }); }
  return out;
}

/**
 * Video second where a synced track ({t, c}) passes point p heading dir: the nearest pass in the same direction within maxDistM,
 * or of several the one nearest to `nearT`. Returns {t, dist_m} or null.
 */
export function timeAt(track, p, dir, { maxDistM = 2 * COVER.maxDistM, maxAngleDeg = COVER.maxAngleDeg, nearT = null } = {}) {
  if (!track?.t?.length || track.c.length < 2) return null;
  const minCos = Math.cos(maxAngleDeg * RAD), k = Math.cos(p[1] * RAD);
  let best = null;
  for (let i = 1; i < track.c.length; i++) {
    const a = track.c[i - 1], b = track.c[i], dx = (b[0] - a[0]) * k, dy = b[1] - a[1], l = Math.hypot(dx, dy);
    if (!l || (dx * dir[0] + dy * dir[1]) / l < minCos) continue;
    const px = (p[0] - a[0]) * k, py = p[1] - a[1], f = Math.max(0, Math.min(1, (px * dx + py * dy) / (l * l)));
    const d = Math.hypot(px - f * dx, py - f * dy) * KM_PER_DEG * 1000;
    if (d > maxDistM) continue;
    const t = track.t[i - 1] + f * (track.t[i] - track.t[i - 1]);
    const score = nearT == null ? d : Math.abs(t - nearT) + d / 1000;
    if (!best || score < best.score) best = { t, dist_m: d, score };
  }
  return best && { t: Math.round(best.t * 10) / 10, dist_m: Math.round(best.dist_m) };
}

/** Nearest point of the route to p within ±windowKm of km0 (all of it when km0 is null): {km, dist_m}. */
export function projectNear(line, cum, p, km0 = null, windowKm = 1) {
  const k = Math.cos(p[1] * RAD);
  let best = { km: km0 ?? 0, dist_m: Infinity };
  for (let i = 1; i < line.length; i++) {
    if (km0 != null && (cum[i] < km0 - windowKm || cum[i - 1] > km0 + windowKm)) continue;
    const a = line[i - 1], b = line[i], ax = (b[0] - a[0]) * k, ay = b[1] - a[1], px = (p[0] - a[0]) * k, py = p[1] - a[1];
    const l2 = ax * ax + ay * ay, f = l2 ? Math.max(0, Math.min(1, (px * ax + py * ay) / l2)) : 0;
    const d = Math.hypot(px - f * ax, py - f * ay) * KM_PER_DEG * 1000;
    if (d < best.dist_m) best = { km: cum[i - 1] + f * (cum[i] - cum[i - 1]), dist_m: d };
  }
  return best;
}

/** The part of the line between km a and b. */
export function sliceLine(line, cum, a, b) {
  const out = [pointAt(line, cum, a)];
  for (let i = 0; i < line.length; i++) if (cum[i] > a && cum[i] < b) out.push(line[i]);
  out.push(pointAt(line, cum, b));
  return out;
}

// --- assignments: [{from_km, video_id}] sorted by from_km; a video holds from its from_km to the next entry (or the end) ---

const SAME_KM = 0.001;
const round = (km) => Math.round(km * 1000) / 1000;

/**
 * Sets the video from km on (video_id null: no video from here). Replaces an entry at the same km, merges an entry into the one
 * before when both have the same video, and drops leading "no video" entries.
 */
export function assignFrom(list, km, video_id) {
  km = round(Math.max(0, km));
  let out = list.filter((x) => Math.abs(x.from_km - km) >= SAME_KM).concat({ from_km: km, video_id: video_id ?? null }).sort((a, b) => a.from_km - b.from_km);
  out = out.filter((x, i) => (i === 0 ? x.video_id != null : x.video_id !== out[i - 1].video_id));
  return out.map(({ from_km, video_id: v }) => ({ from_km, video_id: v }));
}

/** Removes the entry starting at from_km (the one before then holds on), with the same merging. */
export function removeAt(list, from_km) {
  const rest = list.filter((x) => Math.abs(x.from_km - from_km) >= SAME_KM);
  return rest.filter((x, i) => (i === 0 ? x.video_id != null : x.video_id !== rest[i - 1].video_id));
}

/** Assignments as segments with their end: [{from_km, to_km, video_id}]. */
export const segmentsOf = (list, totalKm) => list.map((x, i) => ({ ...x, to_km: i + 1 < list.length ? list[i + 1].from_km : round(totalKm) }));

/** The segment holding km, or null. */
export function segmentAt(segs, km) {
  for (const s of segs) if (s.from_km <= km + 1e-9 && km < s.to_km) return s;
  const last = segs.at(-1);
  return last && km >= last.from_km && km <= last.to_km + 1e-9 ? last : null;
}

/** Ascent and descent of a profile [[km, ele], …] with a hysteresis of minStep metres. */
export function climb(profile, minStep = 3) {
  let up = 0, down = 0, ref = profile?.[0]?.[1];
  for (const [, e] of profile ?? []) { if (e - ref >= minStep) { up += e - ref; ref = e; } else if (ref - e >= minStep) { down += ref - e; ref = e; } }
  return { up: Math.round(up), down: Math.round(down) };
}

/**
 * A first assignment for the whole route: from km 0, the video holding the position that ranks highest (rank(id), e.g. synced first)
 * and, of equal rank, rides on furthest; where no video rides, "no video" until the next one starts.
 */
export function autoAssign(cov, totalKm, rank = () => 0) {
  const ivs = cov.flatMap((c) => c.intervals.map((iv) => ({ id: c.id, ...iv })));
  let x = 0, list = [];
  for (let guard = 0; x < totalKm - COVER.minKm / 2 && guard < 10000; guard++) {
    const here = ivs.filter((iv) => iv.from_km <= x + 0.05 && iv.to_km > x + 0.05).sort((a, b) => rank(b.id) - rank(a.id) || b.to_km - a.to_km);
    if (here.length) { list = assignFrom(list, x, here[0].id); x = here[0].to_km; continue; }
    if (list.length) list = assignFrom(list, x, null);
    const next = ivs.filter((iv) => iv.from_km > x).sort((a, b) => a.from_km - b.from_km)[0];
    if (!next) break;
    x = next.from_km;
  }
  return list;
}
