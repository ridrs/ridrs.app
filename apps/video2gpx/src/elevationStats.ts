// Pure functions of the Höhe stage (no DOM): grade, the stretches the chart points at, axis ticks, zoom arithmetic.
// Only type imports here: the module also runs under `node --test` (tests/elevation/elevationStats.test.ts).

/** German number: comma as the decimal separator */
export const de = (x: number, d = 0): string => x.toFixed(d).replace(".", ",");

/** grade in % at every sample, from the heights `win` metres apart (central difference, one-sided at the ends) */
export function gradeSeries(z: ArrayLike<number>, ds: number, win = 50): number[] {
  const k = Math.max(1, Math.round(win / ds / 2)), n = z.length, g = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - k), b = Math.min(n - 1, i + k);
    g[i] = b > a ? ((z[b] - z[a]) / ((b - a) * ds)) * 100 : 0;
  }
  return g;
}

/** 0 green (< 4 %), 1 yellow (< 8 %), 2 orange (< 12 %), 3 red (12 % and more); the grade counts without its sign */
export const gradeClass = (g: number): 0 | 1 | 2 | 3 => { const a = Math.abs(g); return a < 4 ? 0 : a < 8 ? 1 : a < 12 ? 2 : 3; };
export const GRADE_LABEL = ["unter 4 %", "4–8 %", "8–12 %", "über 12 %"] as const;

/** largest |grade| in % over `win` metres (the figure of the key figures) */
export function maxGrade(z: ArrayLike<number>, ds: number, win = 50): number {
  const k = Math.max(1, Math.round(win / ds));
  let m = 0;
  for (let i = 0; i + k < z.length; i++) m = Math.max(m, Math.abs(z[i + k] - z[i]) / (k * ds) * 100);
  return m;
}

export interface Stretch { a: number; b: number; kind: "diff" | "steep"; value: number }

/** moving average of |z - ref| over `win` metres; null in `ref` counts as no difference */
export function smoothedDifference(z: ArrayLike<number>, ref: ArrayLike<number | null>, ds: number, win = 100): number[] {
  const n = z.length, d = new Array<number>(n);
  for (let i = 0; i < n; i++) { const r = ref[i]; d[i] = r === null || r === undefined || !Number.isFinite(r) ? 0 : Math.abs(z[i] - r); }
  const k = Math.max(1, Math.round(win / ds / 2)), out = new Array<number>(n);
  const cs = new Array<number>(n + 1); cs[0] = 0;
  for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + d[i];
  for (let i = 0; i < n; i++) { const a = Math.max(0, i - k), b = Math.min(n, i + k + 1); out[i] = (cs[b] - cs[a]) / (b - a); }
  return out;
}

/** the `count` places where the final profile and the comparison differ most (smoothed over `win` m), at least `sep` m apart and at least
 *  `minDiff` m different. `a`..`b` is the stretch around the peak where the difference is above half of it. */
export function topDifferences(z: ArrayLike<number>, ref: ArrayLike<number | null>, ds: number, s0 = 0, count = 5, sep = 300, minDiff = 1.5, win = 100): Stretch[] {
  const sm = smoothedDifference(z, ref, ds, win);
  const order = Array.from(sm, (_, i) => i).sort((p, q) => sm[q] - sm[p]);
  const out: Stretch[] = [];
  for (const i of order) {
    if (out.length >= count || sm[i] < minDiff) break;
    const arc = s0 + i * ds;
    if (out.some((s) => Math.abs((s.a + s.b) / 2 - arc) < sep)) continue;
    let lo = i, hi = i;
    while (lo > 0 && sm[lo - 1] >= sm[i] / 2) lo--;
    while (hi < sm.length - 1 && sm[hi + 1] >= sm[i] / 2) hi++;
    out.push({ a: s0 + lo * ds, b: s0 + hi * ds, kind: "diff", value: sm[i] });
  }
  return out.sort((p, q) => p.a - q.a);
}

/** stretches where the grade over `win` m exceeds `limit` % (runs closer than `merge` m are one stretch); value = the steepest grade */
export function steepStretches(z: ArrayLike<number>, ds: number, s0 = 0, limit = 12, win = 50, merge = 100): Stretch[] {
  const g = gradeSeries(z, ds, win), out: Stretch[] = [];
  let cur: Stretch | null = null;
  for (let i = 0; i < g.length; i++) {
    if (Math.abs(g[i]) <= limit) continue;
    const arc = s0 + i * ds;
    if (cur && arc - cur.b <= merge) { cur.b = arc; cur.value = Math.max(cur.value, Math.abs(g[i])); }
    else { cur = { a: arc, b: arc, kind: "steep", value: Math.abs(g[i]) }; out.push(cur); }
  }
  return out;
}

/** "nice" tick values (1, 2, 5 × 10^k) inside [lo, hi], about `target` of them */
export function niceTicks(lo: number, hi: number, target = 6): number[] {
  const span = hi - lo;
  if (!(span > 0)) return [lo];
  const raw = span / Math.max(1, target), p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
  const step = (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v / step) * step + 0);
  return out;
}

export interface View { v0: number; v1: number }
export const MIN_SPAN_M = 200;

/** keep a view inside [s0, s1], no narrower than MIN_SPAN_M (or the whole route, if that is shorter) */
export function clampView(v: View, s0: number, s1: number, minSpan = MIN_SPAN_M): View {
  const total = s1 - s0, min = Math.min(minSpan, total);
  let span = Math.max(min, Math.min(total, v.v1 - v.v0));
  let a = v.v0 + ((v.v1 - v.v0) - span) / 2;
  a = Math.max(s0, Math.min(s1 - span, a));
  return { v0: a, v1: a + span };
}
/** zoom by `factor` (< 1 in) around the arc `at`; the point under `at` stays where it is */
export function zoomAround(v: View, factor: number, at: number, s0: number, s1: number): View {
  const span = v.v1 - v.v0, f = span > 0 ? (at - v.v0) / span : 0.5;
  const ns = Math.max(Math.min(MIN_SPAN_M, s1 - s0), Math.min(s1 - s0, span * factor));
  return clampView({ v0: at - f * ns, v1: at - f * ns + ns }, s0, s1);
}
/** a view for a stretch with some room around it */
export function viewFor(a: number, b: number, s0: number, s1: number, margin = 0.5): View {
  const span = Math.max(b - a, 1), m = Math.max(span * margin, 60);
  return clampView({ v0: a - m, v1: b + m }, s0, s1);
}

/** the share of the sources at one station as text: "TINITALY 62 %, Copernicus 21 %" (only 5 % and more) */
export function shareText(parts: { title: string; sh: number }[]): string {
  const p = parts.filter((x) => x.sh >= 0.05).sort((a, b) => b.sh - a.sh);
  return p.length ? p.map((x) => `${x.title.replace(/ \(.*\)$/, "").replace(/ [0-9.]+$/, "")} ${Math.round(x.sh * 100)} %`).join(", ") : "keine";
}
