// The Analyse stage of the browser mock: a per-second series for the mock route (curvature of video and map, speed, yaw, quality, the weak stretches with
// causes) and the overlay points of one frame. Scenarios: analyse (one weak stretch), analyse-bad (five, with different causes); ?frame=error makes the overlay fail.
import type { AnalyseCause, AnalyseStretch, FrameBand, FramePoint, InspectFrame, InspectSeries } from "../types";
import { ROUTE, VIDEO_S } from "./fixtures";
import { SC, qp } from "./scenarios";

const N = VIDEO_S + 1, V = 9;
/** deterministic pseudo noise in [-1, 1] */
const noise = (i: number, k: number) => Math.sin(i * 12.9898 + k * 78.233) * 0.5 + Math.sin(i * 4.1414 + k * 1.7) * 0.5;
const r = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;
const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

type Kind = "motion" | "rotation" | "curves" | "ambiguous" | "gap" | "straight";
/** the cause of the n-th weak stretch: the default scenario has one, the bad one five of different kinds */
const KINDS: Kind[] = SC.analyse === "bad" ? ["motion", "rotation", "curves", "ambiguous", "gap"] : ["curves"];

function weakRuns(): [number, number][] {
  const weak = ROUTE.map((p) => p.confidence < 0.5 || !!p.extrapolated);
  const runs: [number, number][] = [];
  for (let i = 0; i < N; i++) {
    if (!weak[i]) continue;
    const last = runs[runs.length - 1];
    if (last && i - last[1] <= 4) last[1] = i + 1; else runs.push([i, i + 1]);
  }
  return runs.filter(([a, b]) => b - a >= 4);
}

let cache: InspectSeries | null = null;
export function series(): InspectSeries {
  if (cache) return cache;
  const runs = weakRuns();
  const kindAt = new Array<Kind | null>(N).fill(null);
  runs.forEach(([a, b], k) => { for (let i = a; i < b; i++) kindAt[i] = KINDS[k % KINDS.length]; });
  // heading of the matched map line, unwrapped; curvature over about 30 m (rad per m, as 1/km)
  const h = ROUTE.map((p) => p.heading);
  for (let i = 1; i < N; i++) { while (h[i] - h[i - 1] > 180) h[i] -= 360; while (h[i] - h[i - 1] < -180) h[i] += 360; }
  const rad = h.map((x) => (x * Math.PI) / 180);
  const kmap = rad.map((_, i) => { const a = Math.max(0, i - 2), b = Math.min(N - 1, i + 2); return b > a ? ((rad[b] - rad[a]) / ((b - a) * V)) * 1000 : 0; });
  const col = <T,>(f: (i: number) => T) => Array.from({ length: N }, (_, i) => f(i));
  const kind = (i: number) => kindAt[i];
  const kvid = col((i) => {
    const k = kind(i);
    const n = (1 + 0.12 * noise(i, 1)) * kmap[i] + 1.2 * noise(i, 2);
    return k === "curves" ? -0.55 * kmap[i] + 14 * Math.sin(i * 0.5) : k === "motion" ? null : n;
  });
  const vf = col((i) => V + 0.5 * Math.sin(i / 11) + (kind(i) === "gap" ? -4 : 0));
  const vv = col((i) => (kind(i) === "motion" || kind(i) === "gap" ? null : vf[i] * (1 + 0.025 * noise(i, 3)) * (kind(i) === "curves" ? 0.74 : 1)));
  const toDeg = (k: number | null, v: number) => (k === null ? null : r(((k / 1000) * v * 180) / Math.PI, 2));
  const yvms = col((i) => (kind(i) === "motion" ? null : toDeg(kvid[i], vf[i]) === null ? null : r(toDeg(kvid[i], vf[i])! + 0.5 * noise(i, 4), 2)));
  const yfar = col((i) => (kind(i) === "rotation" || kind(i) === "motion" ? null : toDeg(kvid[i], vf[i]) === null ? null : r(toDeg(kvid[i], vf[i])! * 0.97 + 0.15 * noise(i, 5), 2)));
  const s = col((i) => ROUTE[i].arc_m ?? i * V);
  const inl = col((i) => (kind(i) === "motion" ? r(7 + 4 * Math.abs(noise(i, 6)), 0) : r(112 + 18 * noise(i, 6), 0)));
  const usable = col((i) => (kind(i) === "motion" ? r(0.3 + 0.15 * Math.abs(noise(i, 7)), 2) : r(0.99 - 0.02 * Math.abs(noise(i, 7)), 2)));
  const sd = col((i) => (kind(i) === "gap" || kind(i) === "curves" ? r(24 + 8 * Math.abs(noise(i, 8)), 1) : ROUTE[i].extrapolated ? 33 : r(5.5 + 1.5 * Math.abs(noise(i, 8)), 1)));
  const conf = ROUTE.map((p) => (p.extrapolated ? 0 : r(p.confidence, 3)));
  const inGap = col((i) => (ROUTE[i].in_gap || kind(i) === "gap" ? 1 : 0));
  const cuts: [number, number][] = SC.analyse === "bad" ? [[62.4, 62.4]] : [];
  const odo: [number, number][] = SC.analyse === "bad" ? [[16, 28]] : [];

  const T = (c: Omit<AnalyseCause, "unit"> & { unit?: string }): AnalyseCause => ({ unit: "", ...c });
  const causeOf = (k: Kind, a: number, b: number): AnalyseCause[] => {
    const m = (arr: (number | null)[]) => { const x = arr.slice(a, b).filter((v): v is number => v !== null); return x.length ? x.reduce((p, q) => p + q, 0) / x.length : 0; };
    switch (k) {
      case "motion": return [T({ id: "odofail", text: `Wegmessung ausgefallen (Gegenlicht, glatter Belag o. ä.): ${Math.round(100 * 0.8)} % der Zeit`, value: 80, limit: 30, unit: "%" }),
        T({ id: "motion", text: `Videobewegung unsicher: nur ${Math.round(100 * m(usable))} % der Bildpaare nutzbar, im Mittel ${Math.round(m(inl))} Inlier`, value: 100 * m(usable), limit: 60, unit: "%" })];
      case "rotation": return [T({ id: "rotation", text: "Rotation verrauscht: Fernmerkmale nur in 31 % der Fenster (zu wenige Inlier)", value: 31, limit: 50, unit: "%" }),
        T({ id: "cut", text: `Szenenschnitt bei ${clock(62.4)}`, value: 62.4, limit: 5, unit: "s" })];
      case "curves": return [T({ id: "curves", text: "Kurven passen nicht zur Karte: Kurvenrate weicht im Mittel um 71° je 100 m ab (sonst 24°), 118° Drehung im Abschnitt", value: 71, limit: 36, unit: "°/100 m" }),
        T({ id: "speed", text: `Geschwindigkeit passt nicht: Video ${r(m(vv), 1)} m/s, Strecke auf der Karte ${r(m(vf), 1)} m/s (−26 %)`, value: -26, limit: 25, unit: "%" }),
        T({ id: "spread", text: `Position streut ± ${Math.round(m(sd))} m (im Mittel über den Abschnitt)`, value: m(sd), limit: 20, unit: "m" })];
      case "gap": return [T({ id: "gap", text: "Lücke in der Wegmessung (Strecke geschätzt): 100 % der Zeit", value: 100, limit: 30, unit: "%" }), T({ id: "spread", text: `Position streut ± ${Math.round(m(sd))} m (im Mittel über den Abschnitt)`, value: m(sd), limit: 20, unit: "m" })];
      case "straight": return [T({ id: "straight", text: "Lange Gerade: nur 6° Drehung auf 310 m, nichts zum Anpassen entlang der Straße", value: 6, limit: 10, unit: "°" })];
      default: return [T({ id: "ambiguous", text: "Mehrere Straßen passen ähnlich gut: die gewählte nur mit 30 % Wahrscheinlichkeit (die Routensuche war hier 99 % sicher)", value: 30, limit: 50, unit: "%" })];
    }
  };
  const stretches: AnalyseStretch[] = runs.map(([a, b], k) => {
    const cs = conf.slice(a, b);
    return { t0: a, t1: b, s0: r(s[a], 1), s1: r(s[b - 1], 1), dur: b - a, kind: "low", conf_min: Math.min(...cs), conf_mean: r(cs.reduce((p, q) => p + q, 0) / cs.length, 3), causes: causeOf(KINDS[k % KINDS.length], a, b) };
  });
  const kv = kvid.map((v) => (v === null ? null : r(v, 2)));
  const kd = kv.map((v, i) => (v === null ? null : r(v - kmap[i], 2)));
  const cells = { s: [] as number[], t0: [] as (number | null)[], t1: [] as (number | null)[], dev: [] as (number | null)[], match: [] as (number | null)[], turn_v: [] as (number | null)[], turn_m: [] as (number | null)[] };
  for (let c = 0; c * 100 < s[N - 1]; c++) {
    const idx = col((i) => i).filter((i) => s[i] >= c * 100 && s[i] < (c + 1) * 100 && kv[i] !== null);
    if (idx.length < 3) continue;
    const d = idx.map((i) => Math.abs(kv[i]! - kmap[i])), dm = d.reduce((p, q) => p + q, 0) / d.length, rm = Math.sqrt(idx.reduce((p, i) => p + kmap[i] ** 2, 0) / idx.length);
    cells.s.push(c * 100); cells.t0.push(idx[0]); cells.t1.push(idx[idx.length - 1]); cells.dev.push(r(((dm / 1000) * 100 * 180) / Math.PI, 2));
    cells.match.push(r(Math.max(0, 1 - Math.sqrt(idx.reduce((p, i) => p + (kv[i]! - kmap[i]) ** 2, 0) / idx.length) / Math.max(rm, 1000 / 300)), 2)); cells.turn_v.push(0); cells.turn_m.push(0);
  }
  cache = {
    version: 1, pipeline_hash: "0123456789abcdef", result_mtime: 1, window_m: 30, n: N, t0: 0, dt: 1, fps: 30, f_eff: 421.3, kappa: 1.0619, scale_from_route: true, intro_end: null,
    t: col((i) => i), s, speed_fused: vf.map((v) => r(v, 2)), speed_vms: vv.map((v) => (v === null ? null : r(v, 2))),
    yaw_vms: yvms, yaw_far: yfar, yaw: col((i) => (yfar[i] ?? yvms[i])), pitch: col((i) => (kind(i) === "motion" ? null : r(0.8 * noise(i, 9), 2))), roll: col((i) => (kind(i) === "motion" ? null : r(0.4 * noise(i, 10), 2))),
    inliers: inl, rms: col((i) => (kind(i) === "motion" ? null : r(0.45 + 0.12 * noise(i, 11) + (kind(i) === "curves" ? 0.5 : 0), 2))), usable, far_ok: col((i) => (kind(i) === "rotation" ? r(0.3 + 0.1 * noise(i, 12), 2) : kind(i) === "motion" ? 0 : 1)),
    far_inl: col((i) => (kind(i) === "rotation" ? 0 : r(160 + 30 * noise(i, 13), 0))), far_why: col((i) => (kind(i) === "rotation" ? 2 : 0)), far_why_text: ["", "zu wenige Merkmale", "zu wenige Inlier", "Bildbereich zu schmal", "Fit unsicher"],
    kappa_video: kv, kappa_map: kmap.map((v) => r(v, 2)), kappa_diff: kd,
    conf, p_search: col(() => 0.99), s_sd: sd, in_gap: inGap, extrap: ROUTE.map((p) => (p.extrapolated ? 1 : 0)), tunnel: col((i) => (SC.analyse === "bad" && i >= 120 && i <= 126 ? 1 : 0)),
    cut: col((i) => (cuts.some(([a, b]) => i >= a - 0.5 && i <= b + 0.5) ? 1 : 0)), odofail: col((i) => (odo.some(([a, b]) => i >= a && i <= b) ? 1 : 0)), local: col((i) => (SC.analyse === "bad" && i >= 142 && i <= 150 ? 1 : 0)),
    cells, odofail_spans: odo, cuts, limits: { conf_low: 0.5, conf_high: 0.9 }, stretches, seconds: 1.1,
  };
  return cache;
}

// ---------------------------------------------------------------- one frame
const W = 640, H = 360, HORIZON = 150, ROAD: [number, number][] = [[250, 166], [390, 166], [576, 349], [64, 349]];
/** deterministic points of the road area with the flow of a forward move and a turn; ~15 % outliers */
function motionPoints(t: number, yaw: number): FramePoint[] {
  const pts: FramePoint[] = [];
  const k = (t * 7.31) % 1;
  for (let i = 0; i < 130; i++) {
    const y = 170 + 175 * Math.abs(noise(i, k * 5 + 1)), half = 120 + (y - 166) * 1.05, x = W / 2 + half * noise(i, k * 5 + 2) * 0.95;
    const s = 0.00032, flow = [s * (x - W / 2) * (y - HORIZON) + yaw * 0.3, s * (y - HORIZON) ** 2];
    const out = noise(i, 3 + k) > 0.7;
    pts.push([r(x, 1), r(y, 1), r(out ? flow[0] * 0.2 + 1.5 * noise(i, 9) : flow[0] + 0.05 * noise(i, 8), 2), r(out ? -flow[1] * 0.4 : flow[1] + 0.05 * noise(i, 7), 2), out ? 0 : 1]);
  }
  return pts;
}
function farPoints(t: number, yaw: number, end: number): FramePoint[] {
  const pts: FramePoint[] = [];
  for (let i = 0; i < 120; i++) {
    const y = 20 + (end - 30) * Math.abs(noise(i, t * 3 + 1)), x = 30 + (W - 60) * Math.abs(noise(i, t * 3 + 2));
    const out = noise(i, t + 3) > 0.62;
    pts.push([r(x, 1), r(y, 1), r(out ? 3 * noise(i, 4) : -yaw * 1.3 * (1 + ((x - W / 2) / 450) ** 2) + 0.1 * noise(i, 5), 2), r(out ? 2 * noise(i, 6) : 0.1 * noise(i, 6), 2), out ? 0 : 1]);
  }
  return pts;
}

export function frame(t: number, what: string): InspectFrame {
  if (qp("frame") === "error") return { ready: false, error: "ffmpeg konnte das Bild nicht lesen (Beispielfehler der Vorschau)", t, video: "/mock/test.mp4", fps: 30, frame_width: W, frame_height: H, seconds: 0 };
  const S = series(), i = Math.max(0, Math.min(N - 1, Math.round(t)));
  const yawDeg = S.yaw_far[i] ?? S.yaw_vms[i] ?? 0;
  const parts = what.split(",");
  const out: InspectFrame = { ready: true, t, video: "/mock/test.mp4", fps: 30, frame_width: W, frame_height: H, seconds: 0.9 };
  const pair = Math.round(t * 30 + 0.5);
  const bad = SC.analyse === "bad" && Math.floor(t / 10) % 4 === 3;
  if (parts.includes("motion")) {
    const pts = motionPoints(t, yawDeg), inl = pts.filter((p) => p[4]).length;
    const row = { frame: String(pair), time: ((pair - 0.5) / 30).toFixed(4), corners: "160", tracked: String(pts.length), inliers: String(inl), rms_px: "0.4521", s: "3.1e-04", c: "0", yaw: "0.12", pitch: "0.02", roll: "1e-4", diff: "5.2", rel_speed: "1.9e-02" };
    out.motion = {
      pair, t: r((pair - 0.5) / 30, 4), width: W, height: H, horizon: HORIZON, roi: [166, 349], polygon: ROAD, points: pts, corners: 160, tracked: pts.length, source: "gefiltert", row,
      stored: bad ? { ...row, inliers: String(inl - 7), yaw: "0.31" } : row, agree: !bad, diff: bad ? { inliers: [String(inl), String(inl - 7)], yaw: ["0.12", "0.31"] } : undefined,
      fit: { inliers: inl, rms: 0.452, s: 3.1e-4, yaw_px: 0.12, pitch_px: 0.02, roll: 1e-4, speed_ms: S.speed_vms[i] ?? 9, yaw_deg_s: r(yawDeg, 2), pitch_deg_s: S.pitch[i] },
    };
  }
  if (parts.includes("rotation")) {
    const ends = [137, 172, 207];
    const bands: FrameBand[] = ends.map((e, b) => {
      const pts = farPoints(t, yawDeg, e), inl = pts.filter((p) => p[4]).length;
      const st = { ok: true, n_pts: pts.length, n_inl: inl, why: "", A: r(yawDeg * 0.9, 3), B: 0.3, C: -0.2, e: 1.1 };
      return { band: b, end: e, ok: true, why: "", n_pts: pts.length, n_inl: inl, points: pts, usable: true, agree: true, A: st.A, B: st.B, C: st.C, e: st.e, sA: 0.2, sigma: 0.4, stored: st };
    });
    out.rotation = { window: Math.floor((t * 30) / 8), ta: r(Math.floor((t * 30) / 8) * 8 / 30, 3), tb: r((Math.floor((t * 30) / 8) + 1) * 8 / 30, 3), k: 8, width: W, height: H, horizon: 142, band_ends: ends, bands, chosen: 0, agree: true, yaw_deg_s: r(yawDeg, 2), pitch_deg_s: 0.4 };
  }
  return out;
}
