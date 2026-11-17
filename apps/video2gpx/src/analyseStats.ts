// Pure functions of the Analyse stage (no DOM): the time axis, the letterboxed picture the overlay lies on, curvature as radius text, series lookups.
// Only type imports here: the module also runs under `node --test` (tests/analyse/analyseStats.test.ts).
import type { AnalyseStretch, InspectSeries } from "./types";

export const de = (x: number, d = 0): string => x.toFixed(d).replace(".", ",");

/** the shortest span the charts zoom to, seconds */
export const MIN_SPAN_S = 10;
export interface View { v0: number; v1: number }

/** keep a view inside [t0, t1], no narrower than `minSpan` (or the whole video, if that is shorter) */
export function clampView(v: View, t0: number, t1: number, minSpan = MIN_SPAN_S): View {
  const total = t1 - t0, min = Math.min(minSpan, total);
  const span = Math.max(min, Math.min(total, v.v1 - v.v0));
  let a = v.v0 + ((v.v1 - v.v0) - span) / 2;
  a = Math.max(t0, Math.min(t1 - span, a));
  return { v0: a, v1: a + span };
}
/** zoom by `factor` (< 1 in) around the time `at`; the point under `at` stays where it is */
export function zoomAround(v: View, factor: number, at: number, t0: number, t1: number, minSpan = MIN_SPAN_S): View {
  const span = v.v1 - v.v0, f = span > 0 ? (at - v.v0) / span : 0.5;
  const ns = Math.max(Math.min(minSpan, t1 - t0), Math.min(t1 - t0, span * factor));
  return clampView({ v0: at - f * ns, v1: at - f * ns + ns }, t0, t1, minSpan);
}
/** a view for a stretch with some room around it (at least 20 s) */
export function viewFor(a: number, b: number, t0: number, t1: number, margin = 0.6): View {
  const span = Math.max(b - a, 1), m = Math.max(span * margin, 10);
  return clampView({ v0: a - m, v1: b + m }, t0, t1);
}

/** m:ss, or h:mm:ss from an hour on */
export function fmtClock(t: number): string {
  const s = Math.max(0, Math.round(t)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`;
}
const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400];
/** tick times (seconds) inside [lo, hi], about `target` of them, on whole steps of 1 s .. 4 h */
export function timeTicks(lo: number, hi: number, target = 6): number[] {
  const span = hi - lo;
  if (!(span > 0)) return [lo];
  const want = span / Math.max(1, target);
  const step = STEPS.find((s) => s >= want) ?? STEPS[STEPS.length - 1];
  const out: number[] = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9; v += step) out.push(v + 0);
  return out;
}
/** "nice" tick values (1, 2, 5 × 10^k) inside [lo, hi], about `target` of them */
export function niceTicks(lo: number, hi: number, target = 4): number[] {
  const span = hi - lo;
  if (!(span > 0)) return [lo];
  const raw = span / Math.max(1, target), p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
  const step = (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v / step) * step + 0);
  return out;
}

/** radius of a curvature (1/km, left positive) as text: "links, R 125 m"; "geradeaus" above 2 km */
export function radiusText(kappaPerKm: number | null | undefined): string {
  if (kappaPerKm === null || kappaPerKm === undefined || !Number.isFinite(kappaPerKm)) return "–";
  const a = Math.abs(kappaPerKm);
  if (a < 0.5) return "geradeaus";
  const r = 1000 / a;
  return `${kappaPerKm > 0 ? "links" : "rechts"}, R ${r >= 1000 ? de(r / 1000, 1) + " km" : de(Math.round(r / 5) * 5 || 1, 0) + " m"}`;
}
/** the curvature (1/km) that belongs to a radius in m (for the axis labels) */
export const kappaOfRadius = (r: number): number => 1000 / r;
/** axis label of a curvature tick: the radius ("R 100") on the sides, "0" in the middle */
export function kappaTickLabel(k: number): string {
  if (Math.abs(k) < 1e-9) return "0";
  const r = 1000 / Math.abs(k);
  return `${k > 0 ? "L" : "R"} ${r >= 1000 ? de(r / 1000, 1) + " km" : de(r, 0) + " m"}`;
}

export interface Rect { x: number; y: number; w: number; h: number }
/** where a picture of `cw` × `ch` lies inside a box of `bw` × `bh` shown with object-fit: contain (centred, letterboxed) */
export function letterbox(bw: number, bh: number, cw: number, ch: number): Rect {
  if (!(bw > 0 && bh > 0 && cw > 0 && ch > 0)) return { x: 0, y: 0, w: Math.max(0, bw), h: Math.max(0, bh) };
  const s = Math.min(bw / cw, bh / ch), w = cw * s, h = ch * s;
  return { x: (bw - w) / 2, y: (bh - h) / 2, w, h };
}
/** analysis-frame coordinates (px at 360 rows) to the canvas: the picture rect and the frame's size */
export const toPicture = (r: Rect, fw: number, fh: number, x: number, y: number): [number, number] => [r.x + (x / fw) * r.w, r.y + (y / fh) * r.h];

/** index of the second at or nearest to video time t in a series */
export function indexAt(S: Pick<InspectSeries, "n" | "t0" | "dt">, t: number): number {
  return Math.max(0, Math.min(S.n - 1, Math.round((t - S.t0) / (S.dt || 1))));
}
export type ConfCls = "high" | "mid" | "low" | "none";
/** the confidence class of the map's colours (util.confClass): extrapolated = none, 0.9 and more high, 0.5 and more mid, else low */
export const confCls = (conf: number | null, extrap: number | boolean): ConfCls => (extrap ? "none" : conf === null ? "none" : conf >= 0.9 ? "high" : conf >= 0.5 ? "mid" : "low");

/** the weak stretch that contains video time t (seconds), or null */
export function stretchAt(list: AnalyseStretch[], t: number): AnalyseStretch | null {
  return list.find((s) => t >= s.t0 && t <= s.t1) ?? null;
}

/** a robust display range of values: the `lo`..`hi` quantiles, padded; symmetric around 0 when `sym` */
export function robustRange(arrays: (number | null)[][], lo = 0.01, hi = 0.99, sym = false, pad = 0.08, floor = 1): [number, number] {
  const v: number[] = [];
  for (const a of arrays) for (const x of a) if (x !== null && Number.isFinite(x)) v.push(x);
  if (!v.length) return [-floor, floor];
  v.sort((a, b) => a - b);
  let a = v[Math.floor(lo * (v.length - 1))], b = v[Math.ceil(hi * (v.length - 1))];
  if (sym) { const m = Math.max(Math.abs(a), Math.abs(b), floor); return [-m * (1 + pad), m * (1 + pad)]; }
  if (b - a < floor) { const m = (a + b) / 2; a = m - floor / 2; b = m + floor / 2; }
  const p = (b - a) * pad;
  return [a - p, b + p];
}

/** the value of a series at a (fractional) second, linear between neighbours; null where the second has no value */
export function valueAt(a: (number | null)[], i: number): number | null {
  const i0 = Math.floor(i), i1 = Math.min(a.length - 1, i0 + 1);
  if (i0 < 0 || i0 >= a.length) return null;
  const x = a[i0], y = a[i1];
  if (x === null) return null;
  if (y === null || i1 === i0) return x;
  return x + (y - x) * (i - i0);
}
